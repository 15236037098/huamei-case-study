import { z } from 'zod';
import { buildRouterInput } from './context.mjs';
import { decideClarification } from './clarify.mjs';
import { reconcileRecognition } from './reconcile.mjs';
import { validateRecognition } from './schema.mjs';
import { ROUTER_PROMPT_VERSION, ROUTER_SYSTEM_PROMPT } from './prompt.mjs';
import { recognizeAcquisitionIntent } from '../acquisition-intent.mjs';

const CandidateSchema=z.object({
  language:z.enum(['zh-CN','en','mixed','unknown']),
  primary_intent:z.string(),
  tasks:z.array(z.object({intent:z.string(),evidence:z.string()})).min(1).max(3),
  slots:z.array(z.object({field:z.enum(['project','product','doctor','time_preference','budget','style_preference','concern']),
    value:z.string(),source:z.enum(['current_explicit','pending_answer','session_confirmed']),evidence:z.string().optional()})).max(12)
}).passthrough();

function parseCandidate(raw) {
  if(typeof raw==='string') {
    const cleaned=raw.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
    return JSON.parse(cleaned);
  }
  if(raw && typeof raw==='object' && typeof raw.content==='string')return parseCandidate(raw.content);
  return raw;
}

function validatedPendingValue(field,message) {
  const value=String(message || '').trim();
  if(field==='time_preference')return /(?:今天|明天|后天|周[一二三四五六日天]|星期[一二三四五六日天]|\d{1,2}月\d{1,2}日|上午|下午|晚上|\d{1,2}点)/u.test(value)?value:null;
  if(field==='project'||field==='product') {
    const entities=recognizeAcquisitionIntent(value).entities;
    return entities.projects?.find(project=>value.includes(project)) || null;
  }
  return null;
}

async function invokeLangChain(input) {
  const [{ChatOpenAI},{ChatPromptTemplate},{SystemMessage}]=await Promise.all([
    import('@langchain/openai'),import('@langchain/core/prompts'),import('@langchain/core/messages')
  ]);
  const model=new ChatOpenAI({
    apiKey:process.env.DEMO_LLM_API_KEY || process.env.OPENAI_API_KEY,
    model:process.env.DEMO_LLM_MODEL || 'gpt-4o-mini',temperature:0,
    timeout:Math.max(1000,Math.min(60000,Number(process.env.DEMO_INTENT_ROUTER_TIMEOUT_MS)||30000)),maxRetries:0,
    configuration:{baseURL:process.env.DEMO_LLM_BASE_URL || undefined}
  });
  const prompt=ChatPromptTemplate.fromMessages([
    new SystemMessage(ROUTER_SYSTEM_PROMPT),
    ['human','可信输入 JSON：\n{router_input}']
  ]);
  const values={router_input:JSON.stringify(input)};
  // The configured OpenAI-compatible provider does not reliably support
  // tool-call JSON schemas. Keep LangChain for the prompt/model chain and
  // validate the JSON ourselves with the same strict Zod + domain contract.
  const response=await prompt.pipe(model).invoke(values);
  return parseCandidate(response);
}

export async function recognize({message,channel,router_state={}}, {invokeStructured=invokeLangChain}={}) {
  const input=buildRouterInput(message,channel,router_state);
  const context={dialogue_summary:input.router_state.dialogue_summary,last_intent:input.router_state.last_intent,
    current_topic:input.router_state.current_topic,pending_clarification:input.router_state.pending_clarification};
  const pending=router_state?.pending_clarification;
  const shortAnswer=String(message || '').trim();
  if(pending?.status==='open' && /^(?:不知道|不清楚|还没想好|没想好)[。！!]?$/u.test(shortAnswer)) {
    const active=pending.blocked_tasks?.find(task=>task.task_id===pending.active_task_id);
    if(active) {
      const checked=validateRecognition({language:'zh-CN',primary_intent:active.intent,
        tasks:[{intent:active.intent,evidence:shortAnswer}],slots:[]},
        {message:shortAnswer,channel,router_state});
      if(checked.used) {
        const result=decideClarification(checked.result,router_state,message);
        result.tasks[0].task_id=active.task_id;
        result.clarification.question=String(pending.question || '').includes('人工顾问')
          ? '可以先不确定项目。您更想了解哪个方向？'
          : '没关系，您可以先说关心的部位、项目方向，或让我请人工顾问协助确认。';
        return {used:true,source:'pending_resume',result:{...result,prompt_version:ROUTER_PROMPT_VERSION,channel,context}};
      }
    }
  }
  if(pending?.status==='open' && pending.topic_version===router_state.topic_version
    && shortAnswer.length>0 && shortAnswer.length<=40
    && !/[?？]|(?:多少钱|在哪里|在哪|怎么|介绍|比较|医院|地址|营业|停车|你好|谢谢|不想|不要|不是|换个|取消|同意|确认)/.test(shortAnswer)
    && !/1\d{10}/.test(shortAnswer)) {
    const active=pending.blocked_tasks?.find(task=>task.task_id===pending.active_task_id);
    const field=active?.missing_slots?.[0];
    const confirmedValue=validatedPendingValue(field,shortAnswer);
    if(active && confirmedValue) {
      const currentSlots=Object.entries(router_state.key_slots || {})
        .filter(([name,slot])=>name!==field && slot?.confirmed && slot.topic_version===router_state.topic_version)
        .map(([name,slot])=>({field:name,value:slot.value,source:'session_confirmed',evidence:''}));
      const checked=validateRecognition({language:'zh-CN',primary_intent:active.intent,
        tasks:[{intent:active.intent,evidence:shortAnswer}],
        slots:[...currentSlots,{field,value:confirmedValue,source:'pending_answer',evidence:shortAnswer}]},
        {message:shortAnswer,channel,router_state});
      if(checked.used) {
        const remaining=pending.blocked_tasks.filter(task=>task.task_id!==active.task_id)
          .map(task=>({task_id:task.task_id,intent:task.intent,evidence:task.evidence}));
        const result=decideClarification({...checked.result,tasks:[
          {...checked.result.tasks[0],task_id:active.task_id},...remaining
        ]},router_state,message);
        return {used:true,source:'pending_resume',result:{...result,prompt_version:ROUTER_PROMPT_VERSION,channel,context}};
      }
    }
  }
  try {
    const raw=await invokeStructured(input);
    const parsed=CandidateSchema.safeParse(parseCandidate(raw));
    if(!parsed.success)return {used:false,reason:'invalid_model_schema'};
    const checked=validateRecognition(parsed.data,{message:input.message,channel,router_state});
    if(!checked.used)return checked;
    const active=pending?.status==='open' && pending.topic_version===router_state.topic_version
      ? pending.blocked_tasks?.find(task=>task.task_id===pending.active_task_id):null;
    if(active && checked.result.tasks.length===1 && checked.result.tasks[0].intent===active.intent
      && checked.result.slots.some(slot=>slot.source==='pending_answer' && active.missing_slots?.includes(slot.field))) {
      checked.result.tasks[0].task_id=active.task_id;
    }
    const reconciled=reconcileRecognition(checked.result,{message:input.message,router_state});
    return {used:true,source:'langchain',result:{...decideClarification(reconciled,router_state,message),
      prompt_version:ROUTER_PROMPT_VERSION,channel,context}};
  } catch(error) {
    const diagnostic=String(error?.code || error?.status || error?.name || '').slice(0,40);
    return {used:false,reason:'model_unavailable_or_invalid_json',diagnostic};
  }
}
