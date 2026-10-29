import { INTENT_ONTOLOGY } from './acquisition-intent.mjs';

export const TURN_PLAN_VERSION = '1.0.0';
export const TURN_INTENTS = Object.keys(INTENT_ONTOLOGY).filter(key => !['risk','restricted'].includes(INTENT_ONTOLOGY[key].domain));
TURN_INTENTS.push('contact_submission');
const steps = new Set(['answer', 'clarify', 'offer_appointment', 'defer', 'acknowledge_contact']);
const fields = new Set(['budget', 'time_preference', 'style_preference', 'concern']);
const sourceIdentifiers = current => [
  ...String(current).matchAll(/20\d{2}年\d{1,2}月\d{1,2}日|20\d{6}|《[^》]{2,100}》/gu)
].map(match => match[0]);

// Plans are proposals. Only literal, current-message evidence may update slots;
// no model output can manufacture a contact value or a fulfilled booking.
export function validateTurnPlan(data, { current = '' } = {}) {
  const bad = reason => ({ used:false, reason });
  const text = (value, max) => typeof value === 'string' && value.length <= max;
  if (!data || typeof data !== 'object' || !Number.isFinite(data.confidence) || data.confidence < .8 || data.confidence > 1) return bad('low_confidence_or_schema');
  if (!TURN_INTENTS.includes(data.intent) || !steps.has(data.next_step) || !text(data.clarification, 120)) return bad('invalid_plan_schema');
  if (!Array.isArray(data.questions) || data.questions.length > 3 || data.questions.some(q => !q || !TURN_INTENTS.includes(q.intent) || !text(q.query, 160) || !q.query.trim())) return bad('invalid_questions');
  const identifiers=sourceIdentifiers(current);
  const lostIdentifiers=identifiers.filter(identifier=>!data.questions.some(question=>question.query.includes(identifier)));
  if(lostIdentifiers.length && (data.questions.length!==1 || current.length>160 || /1\d{10}|\[联系方式\]/u.test(current)))return bad('unpreserved_source_identifier');
  const questions=lostIdentifiers.length ? [{...data.questions[0],query:current}] : data.questions;
  if (data.next_step === 'clarify' && !data.clarification.trim()) return bad('missing_clarification');
  if (!Array.isArray(data.slot_updates) || data.slot_updates.length > 4) return bad('invalid_slots');
  const groundedSlots=data.slot_updates.filter(s=>s && fields.has(s.field) && text(s.value,80) && s.value && current.includes(s.value));
  const discardedSlots=data.slot_updates.length-groundedSlots.length;
  const validTask=data.task && ['unchanged','interested','deferred'].includes(data.task.willingness) && text(data.task.evidence,100)
    && (data.task.willingness==='unchanged' || data.task.evidence && current.includes(data.task.evidence));
  // A bad optional extraction must not erase an otherwise usable understanding.
  // Discard it; never write model-invented values or advance an ungrounded task.
  data={...data,task:validTask?data.task:{willingness:'unchanged',evidence:''}};
  if(data.task.willingness==='interested' && /(?:不|别|暂缓|取消|缓缓).{0,5}(?:约|登记|面诊)|没空|别催/.test(data.task.evidence))return bad('negated_appointment_interest');
  if(data.next_step==='defer' && data.task.willingness!=='deferred')return bad('deferral_without_evidence');
  const discardedStep=data.next_step==='offer_appointment' && data.task.willingness!=='interested';
  if(discardedStep)data={...data,next_step:data.intent==='contact_submission'?'acknowledge_contact':'answer'};
  if (data.task.willingness === 'deferred' && data.next_step === 'offer_appointment') return bad('contradictory_task');
  return { used:true, version:TURN_PLAN_VERSION, confidence:data.confidence, intent:data.intent,
    questions:questions.map(q=>({intent:q.intent,query:q.query.trim()})),
    clarification:data.clarification.trim(), next_step:data.next_step,
    discarded_task:!validTask, discarded_next_step:discardedStep, discarded_slot_updates:discardedSlots, slot_updates:groundedSlots.map(s=>({field:s.field,value:s.value})),
    task:{willingness:data.task.willingness,evidence:data.task.evidence} };
}

// 建模返回的意图是“建议”，当前消息里有明确项目名和了解/介绍动作时，
// 不能降级成上下文追问（DLG-A-1 的间歇误判）。只在证据明确、无价格/对比意图时归一。
const EXPLICIT_LEARN_ACT = /(?:了解|介绍|讲讲|说一下|是什么|怎么样|科普|想知道)/;
const PRICE_OR_COMPARISON = /(?:多少钱|价格|费用|报价|收费|区别|对比|哪个好|怎么选)/;
const DEFERRAL = /(?:先|暂时|暂)(?:不|别)(?:预约|约了?|做)|不(?:着急|急着)(?:预约|约|做)|先不约/;
const PRODUCT_ATTRIBUTE_TERMS = /(?:型号|形态|光面|毛面|绒面|圆形|水滴|解剖型|规格|材质)/;
const PRODUCT_NAME = /(?:璀璨|曼托|傲诺拉|星熠|特贝茨|假体|瑞可丽|面膜)/;

const withPlanIntent = (plan, intent, reason) => ({
  ...plan,
  intent,
  questions: (plan.questions || []).map((item, index) => index === 0 ? { ...item, intent } : item),
  next_step: plan.next_step === "clarify" ? "answer" : plan.next_step,
  clarification: "",
  reconciled_intent: { from:plan.intent, to:intent, reason }
});

export function reconcilePlannedIntent(plan, { message = "", analysis = {} } = {}) {
  if (!plan?.used) return plan;
  const text = String(message || "");
  const entities = analysis?.entities || {};
  const negatedProjects = [...new Set([
    ...(entities.negated_projects || []),
    ...(entities.negated_project_mentions || [])
  ].filter(Boolean))];
  const correctedProjects = (entities.projects || []).filter(Boolean);
  const correctedLabels = (entities.project_mentions || [])
    .map((item) => item?.mention)
    .filter(Boolean);
  // “不是X，我想看Y”是确定性纠正：模型计划不能再把 X 带回比较问题。
  // 只保留本轮肯定项目，并把检索问题收敛到该项目。
  if (negatedProjects.length && correctedProjects.length) {
    const correctedQuery = correctedLabels.slice(0, 2).join(" ") || correctedProjects.slice(0, 2).join(" ");
    const retained = (plan.questions || []).filter((item) =>
      !negatedProjects.some((term) => String(item?.query || "").includes(term))
    );
    const questions = (retained.length ? retained : [{ intent:"project_explanation", query:correctedQuery }])
      .map((item, index) => index === 0
        ? { ...item, intent:"project_explanation", query:correctedQuery }
        : item);
    return {
      ...plan,
      intent:"project_explanation",
      questions,
      next_step:plan.next_step === "clarify" ? "answer" : plan.next_step,
      clarification:"",
      reconciled_intent:{
        from:plan.intent,
        to:"project_explanation",
        reason:"explicit_project_correction",
        negated:negatedProjects,
        project:correctedProjects[0]
      }
    };
  }
  const explicitProjects = (analysis?.entities?.projects || []).filter((name) => name && text.includes(name));
  const explicitDoctors = (analysis?.entities?.doctors || []).filter((name) => name && text.includes(name));
  // 纯收尾（先不预约了/谢谢）不得被规划器当成售前协调任务。
  if (DEFERRAL.test(text) && !explicitProjects.length && !explicitDoctors.length && text.length <= 30) {
    return withPlanIntent(plan, "conversation_acknowledgement", "explicit_deferral");
  }
  // 点名产品 + 型号/形态等属性词，优先产品属性核验。
  if (PRODUCT_ATTRIBUTE_TERMS.test(text) && PRODUCT_NAME.test(text)
    && !/(?:多少钱|价格|收费|报价)/.test(text) && plan.intent !== "product_attribute_verification") {
    return withPlanIntent(plan, "product_attribute_verification", "product_attribute_terms");
  }
  const questions = Array.isArray(plan.questions) ? plan.questions : [];
  const hasContextIntent = plan.intent === "conversation_followup"
    || questions.some((item) => item?.intent === "conversation_followup");
  if (!hasContextIntent || !EXPLICIT_LEARN_ACT.test(text) || PRICE_OR_COMPARISON.test(text)) return plan;
  if (!explicitProjects.length) return plan;
  const nextQuestions = questions.map((item, index) => index === 0 && item.intent === "conversation_followup"
    ? { ...item, intent:"project_explanation" }
    : item);
  return {
    ...plan,
    intent:plan.intent === "conversation_followup" ? "project_explanation" : plan.intent,
    questions:nextQuestions,
    reconciled_intent:{
      from:"conversation_followup",
      to:"project_explanation",
      reason:"explicit_project_with_learn_act",
      project:explicitProjects[0]
    }
  };
}

export function applyTurnPlanContext(context, plan) {
  if (!plan?.used) return context;
  const slots = {...context.known_slots};
  for (const update of plan.slot_updates) slots[update.field] = update.value;
  const state = {...context.presales_state};
  if (plan.task.willingness !== 'unchanged') state.willingness = plan.task.willingness;
  if (plan.next_step === 'defer') state.willingness = 'deferred';
  if (slots.time_preference) state.visit_preference = slots.time_preference;
  return {...context, known_slots:slots, presales_state:state,
    profile:{...context.profile,...slots}, turn_plan:plan};
}
