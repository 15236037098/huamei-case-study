import { redactContactPii } from '../platform/contact-pii-redaction.mjs';
import { TURN_INTENTS } from '../acquisition-turn-plan.mjs';

const clean = (value,max=500) => redactContactPii(String(value || '')).replace(/\b\d{15,18}[0-9Xx]\b/g,'[证件号已脱敏]').slice(0,max);
const slotFields = new Set(['project','product','doctor','time_preference','budget','style_preference','concern']);
const topicFields = ['project','product','doctor'];
const slotSources = new Set(['current_explicit','pending_answer','session_confirmed']);
const routerIntents = new Set(TURN_INTENTS.filter(intent=>!['human_handover_request','contact_submission'].includes(intent)));
const safeSlot = value => value && typeof value === 'object' && value.confirmed === true && ['current_explicit','pending_answer','session_confirmed'].includes(value.source)
  ? {value:clean(value.value,80),source:value.source,confirmed:true,topic_version:Number(value.topic_version)||0,source_message_id:clean(value.source_message_id,128)} : null;
const safeTopic = (topic,version) => {
  if(!topic || typeof topic!=='object' || topic.confirmed!==true || topic.topic_version!==version || !topic.source_message_id)return null;
  const values={};
  for(const field of topicFields)if(typeof topic[field]==='string' && topic[field].trim())values[field]=clean(topic[field],80);
  if(!Object.keys(values).length)return null;
  return {...values,confirmed:true,topic_version:version,source_message_id:clean(topic.source_message_id,128),
    ...(slotSources.has(topic.source)?{source:topic.source}:{})};
};
const safePending = (pending,version) => {
  if(!pending || typeof pending!=='object' || pending.status!=='open' || pending.topic_version!==version || !Array.isArray(pending.blocked_tasks))return null;
  if(!routerIntents.has(pending.primary_intent) || pending.blocked_tasks.some(task=>!routerIntents.has(task?.intent)))return null;
  return {status:'open',topic_version:version,primary_intent:clean(pending.primary_intent,80),
    active_task_id:clean(pending.active_task_id,40),
    blocked_tasks:pending.blocked_tasks.slice(0,3).filter(task=>task && typeof task==='object').map(task=>({
      task_id:clean(task.task_id,40),intent:clean(task.intent,80),evidence:clean(task.evidence,160),
      slots:Array.isArray(task.slots)?task.slots.slice(0,12).filter(slot=>slot && slotFields.has(slot.field) && typeof slot.value==='string')
        .map(slot=>({field:slot.field,value:clean(slot.value,80)})):[],
      missing_slots:Array.isArray(task.missing_slots)?task.missing_slots.filter(field=>slotFields.has(field)).slice(0,12):[],
      block_reason:clean(task.block_reason,80)
    })),
    answered_task_ids:Array.isArray(pending.answered_task_ids)?pending.answered_task_ids.map(id=>clean(id,40)).slice(0,3):[],
    question:clean(pending.question,240),clarification_kind:'missing_information',
    created_turn:Math.max(0,Number(pending.created_turn)||0),source_message_id:clean(pending.source_message_id,128)};
};

export function initialRouterState() {
  return {last_intent:null,last_tool_call:null,key_slots:{},dialogue_summary:'',current_topic:null,pending_clarification:null,pending_confirmation:null,topic_version:0};
}

export function normalizeRouterState(raw) {
  const source=raw && typeof raw === 'object' ? raw : {};
  const state=initialRouterState();
  state.topic_version=Math.max(0,Number(source.topic_version)||0);
  state.last_intent=routerIntents.has(source.last_intent) ? source.last_intent : null;
  state.dialogue_summary=clean(source.dialogue_summary,500);
  for (const [field,value] of Object.entries(source.key_slots || {})) {
    if (slotFields.has(field)) {
      const slot=safeSlot(value); if(slot)state.key_slots[field]=slot;
    }
  }
  state.current_topic=safeTopic(source.current_topic,state.topic_version);
  state.pending_clarification=safePending(source.pending_clarification,state.topic_version);
  const last=source.last_tool_call;
  if(last && typeof last.name==='string' && ['knowledge_search','doctor_search','price_search'].includes(last.name)
    && ['success','failed'].includes(last.result_status) && last.source_message_id) {
    const args={};
    for(const key of ['query','project','doctor','product'])if(typeof last.arguments?.[key]==='string')args[key]=clean(last.arguments[key],80);
    state.last_tool_call={name:last.name,arguments:args,result_status:last.result_status,source_message_id:clean(last.source_message_id,128)};
  }
  return state;
}

export function isNegatedTopicValue(currentMessage='',value='') {
  if(typeof value!=='string' || !value)return false;
  const entity=value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const message=String(currentMessage || '');
  return new RegExp(`(?:不是|不要|不看|换掉|排除).{0,8}${entity}`).test(message)
    || new RegExp(`${entity}.{0,6}(?:不要了|不看了|不考虑了|不做了|不想了解了|先不看|先不考虑|换掉|取消)`).test(message);
}

export function resolveCurrentTopic(previousCommittedState={},currentMessage='') {
  const state=normalizeRouterState(previousCommittedState);
  const topic=state.current_topic;
  if(!topic)return null;
  for(const value of [topic.project,topic.doctor,topic.product].filter(Boolean)) {
    if(isNegatedTopicValue(currentMessage,value))return null;
  }
  return topic;
}

export function buildRouterInput(message,channel,routerState={}) {
  const state=normalizeRouterState(routerState);
  const args=state.last_tool_call?.arguments || {};
  const safeArgs={};
  for(const key of ['query','project','doctor','product']) if(typeof args[key]==='string')safeArgs[key]=clean(args[key],80);
  return {
    message:clean(message,1000),channel,
    router_state:{dialogue_summary:state.dialogue_summary,last_intent:state.last_intent,
      last_tool_call:state.last_tool_call?{name:state.last_tool_call.name,arguments:safeArgs,result_status:state.last_tool_call.result_status}:null,
      key_slots:state.key_slots,current_topic:resolveCurrentTopic(state,message),pending_clarification:state.pending_clarification}
  };
}

export function invalidateRouterTopic(previous,currentMessage='') {
  const state=normalizeRouterState(previous);
  if(!state.current_topic || !currentMessage || resolveCurrentTopic(state,currentMessage))return state;
  state.current_topic=null;
  state.pending_clarification=null;
  state.dialogue_summary='';
  for(const field of [...topicFields,'time_preference'])delete state.key_slots[field];
  state.topic_version+=1;
  return normalizeRouterState(state);
}

export function advanceRouterState(previous, recognition, {message_id='',current_message='',tool_call_record=null,turn_index=0}={}) {
  const state=invalidateRouterTopic(previous,current_message);
  if(!recognition?.primary_intent || !Array.isArray(recognition.tasks))return state;
  const slots=(recognition.slots || []).filter(slot=>slotFields.has(slot.field)
    && !(topicFields.includes(slot.field) && isNegatedTopicValue(current_message,slot.value)));
  const topicSlot=slots.find(slot=>['project','doctor','product'].includes(slot.field));
  if(!topicSlot && ['service_information','directory_discovery','conversation_greeting'].includes(recognition.primary_intent)) {
    state.current_topic=null;
    for(const field of ['project','product','doctor','time_preference'])delete state.key_slots[field];
    state.topic_version+=1;
  }
  const changed=topicSlot && state.current_topic?.[topicSlot.field] && state.current_topic[topicSlot.field]!==topicSlot.value;
  if(changed)state.topic_version+=1;
  for(const slot of slots)state.key_slots[slot.field]={value:clean(slot.value,80),source:slot.source,
    confirmed:true,topic_version:state.topic_version,source_message_id:clean(message_id,128)};
  if(topicSlot)state.current_topic={
    ...(changed?{}:state.current_topic || {}),
    [topicSlot.field]:clean(topicSlot.value,80),source:topicSlot.source,confirmed:true,
    topic_version:state.topic_version,source_message_id:clean(message_id,128)
  };
  state.last_intent=recognition.primary_intent;
  const blocked=recognition.tasks.filter(task=>task.state==='blocked');
  state.pending_clarification=blocked.length?{
    primary_intent:recognition.primary_intent,active_task_id:blocked[0].task_id,
    blocked_tasks:blocked.map(task=>({task_id:task.task_id,intent:task.intent,evidence:clean(task.evidence,160),
      slots:slots.map(slot=>({field:slot.field,value:clean(slot.value,80)})),missing_slots:task.missing_slots,
      block_reason:task.block_reason})),
    answered_task_ids:recognition.tasks.filter(task=>['answer_ready','proposal_ready'].includes(task.state)).map(task=>task.task_id),
    question:recognition.clarification?.question || '',clarification_kind:'missing_information',
    topic_version:state.topic_version,created_turn:Math.max(0,Number(turn_index)||0),
    source_message_id:clean(message_id,128),status:'open'
  }:null;
  const topic=state.current_topic;
  state.dialogue_summary=clean([
    topic?.project?`用户当前确认关注${topic.project}`:null,
    topic?.doctor?`用户当前确认关注${topic.doctor}医生`:null,
    state.pending_clarification?`待澄清${blocked[0].intent}：${state.pending_clarification.question}`:null
  ].filter(Boolean).join('；'),500);
  if(tool_call_record?.name && ['knowledge_search','doctor_search','price_search'].includes(tool_call_record.name)
    && ['success','failed'].includes(tool_call_record.result_status)) {
    const args={};
    for(const key of ['query','project','doctor','product'])if(typeof tool_call_record.arguments?.[key]==='string')args[key]=clean(tool_call_record.arguments[key],80);
    state.last_tool_call={name:tool_call_record.name,arguments:args,result_status:tool_call_record.result_status,
      source_message_id:clean(message_id,128)};
  }
  return normalizeRouterState(state);
}
