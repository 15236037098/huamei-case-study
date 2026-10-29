import { INTENT_ONTOLOGY, INTENT_ENGINE_VERSION, recognizeAcquisitionIntent } from '../acquisition-intent.mjs';
import { TURN_INTENTS } from '../acquisition-turn-plan.mjs';
import { isNegatedTopicValue, resolveCurrentTopic } from './context.mjs';

export const RECOGNITION_SCHEMA_VERSION = '1.1';
export const MODEL_PROPOSABLE_INTENTS = Object.freeze(TURN_INTENTS.filter(intent =>
  Object.hasOwn(INTENT_ONTOLOGY, intent) && !['human_handover_request','contact_submission'].includes(intent)
));
export const SLOT_FIELDS = Object.freeze(['project','product','doctor','time_preference','budget','style_preference','concern']);
const languages = new Set(['zh-CN','en','mixed','unknown']);
const sources = new Set(['current_explicit','pending_answer','session_confirmed']);
const isText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;

export function validateRecognition(candidate, trustedInput = {}) {
  const bad = reason => ({used:false,reason});
  const message = String(trustedInput.message || '');
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return bad('invalid_schema');
  if (candidate.channel !== undefined && candidate.channel !== trustedInput.channel) return bad('untrusted_channel');
  if (!languages.has(candidate.language)) return bad('invalid_language');
  if (!MODEL_PROPOSABLE_INTENTS.includes(candidate.primary_intent)) return bad('invalid_primary_intent');
  if (!Array.isArray(candidate.tasks) || candidate.tasks.length < 1 || candidate.tasks.length > 3) return bad('invalid_tasks');
  if (!candidate.tasks.some(task => task?.intent === candidate.primary_intent)) return bad('primary_intent_not_in_tasks');
  const tasks=[];
  let previousEvidenceIndex=-1;
  for (const [index,task] of candidate.tasks.entries()) {
    if (!task || !MODEL_PROPOSABLE_INTENTS.includes(task.intent)) return bad('invalid_task_intent');
    if (!isText(task.evidence,160) || !message.includes(task.evidence)) return bad('ungrounded_task');
    const evidenceIndex=message.indexOf(task.evidence,previousEvidenceIndex+1);
    if(evidenceIndex<0 || evidenceIndex<previousEvidenceIndex)return bad('unordered_tasks');
    previousEvidenceIndex=evidenceIndex;
    if(task.intent==='appointment_request' && /(?:不想|不要|先不|暂缓|取消|别).{0,5}(?:预约|约|面诊)/.test(message))return bad('negated_appointment_request');
    // 自然中文的预约表达不止“预约”二字：想约X面诊、安排一次面诊、登记一个面诊都算明确请求；
    // 仍保留上一行的否定门禁（先不/暂缓/取消/别约）。
    if(task.intent==='appointment_request') {
      // evidence 可能只是“某项目面诊”；预约动作在整句里（“请帮我约某项目面诊”）也应认可，
      // 但仍要求 evidence 本身是原句片段，否证规则不受影响。
      const bookingEvidence=/(?:预约|想约|帮我约|约个|约一次|安排[^。！？]{0,8}面诊|登记[^。！？]{0,8}面诊|安排到院|到院面诊|想去面诊|想来面诊)/;
      if(!bookingEvidence.test(task.evidence)&&!bookingEvidence.test(message))return bad('appointment_without_request_evidence');
    }
    tasks.push({task_id:`t${index+1}`,intent:task.intent,evidence:task.evidence});
  }
  if (!Array.isArray(candidate.slots) || candidate.slots.length > 12) return bad('invalid_slots');
  const slots=[];
  for (const slot of candidate.slots) {
    if (!slot || !SLOT_FIELDS.includes(slot.field) || !sources.has(slot.source) || !isText(slot.value,80)) return bad('invalid_slot');
    if (slot.source === 'current_explicit' || slot.source === 'pending_answer') {
      if (!isText(slot.evidence,100) || !message.includes(slot.evidence) || !slot.evidence.includes(slot.value)) return bad('ungrounded_slot');
      if (slot.source === 'pending_answer' && !trustedInput.router_state?.pending_clarification) return bad('untrusted_pending_answer');
      if(['project','doctor','product'].includes(slot.field) && isNegatedTopicValue(message,slot.value))return bad('negated_slot');
    } else {
      const stateSlot = trustedInput.router_state?.key_slots?.[slot.field];
      if (!stateSlot || !stateSlot.confirmed || stateSlot.value !== slot.value || stateSlot.topic_version !== trustedInput.router_state?.topic_version) return bad('untrusted_session_slot');
      if(['project','doctor','product'].includes(slot.field) && resolveCurrentTopic(trustedInput.router_state,message)?.[slot.field]!==slot.value)return bad('invalidated_topic_slot');
      if(['project','doctor'].includes(slot.field)) {
        const explicit=recognizeAcquisitionIntent(message).entities?.[slot.field==='project'?'projects':'doctors'] || [];
        if(explicit.length && !explicit.includes(slot.value))return bad('current_turn_overrides_session_slot');
      }
    }
    slots.push({field:slot.field,value:slot.value,source:slot.source,evidence:slot.evidence || ''});
  }
  return {used:true,result:{
    schema_version:RECOGNITION_SCHEMA_VERSION,
    intent_engine_version:INTENT_ENGINE_VERSION,
    language:candidate.language,
    primary_intent:candidate.primary_intent,
    tasks,slots
  }};
}
