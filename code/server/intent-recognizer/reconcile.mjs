import { recognizeAcquisitionIntent } from '../acquisition-intent.mjs';

// Router 的模型输出负责语义理解，这里只做“可复核的近邻纠偏”：
// 每条规则都由消息里可见的字面证据触发，不猜测意图、不新增槽位。
const SERVICE = /(?:地址|怎么走|怎么去|怎么坐|地铁|停车|营业|几点关门|几点开门|电话|联系方式|院区)/;
const DIRECTORY = /(?:目录|分类|哪些项目资料|资料库|知识目录|服务范围|明星产品|科室资料)/;
const POLICY = /(?:活动|优惠|折扣|套餐|权益|会员|赠品|促销|有效期|限制条件|政策)/;
const PRODUCT_ATTRIBUTE = /(?:形态|型号|光面|毛面|绒面|圆形|水滴|解剖型|规格|材质|品牌)/;
const APPOINTMENT_TIME = /(?:到院|面诊|预约|号源|可约|名额|有空)/;
const RECOMMEND_DOCTOR = /(?:推荐|哪位|哪个|谁|找哪)/;
const DOCTOR_SCHEDULE = /(?:出诊|坐诊|排班|在院|门诊|号)/;
const DOCTOR_NAME = /[\u4e00-\u9fa5]{2,4}(?:院长|医生|主任)/;
// “到院面诊”本身不是请求证据（“最近哪天可以到院面诊”是查询），必须有约/登记/安排动作。
const APPOINTMENT_REQUEST = /(?:帮我预约|我要预约|我想预约|想约|帮我约|给我登记[^。！？]{0,6}面诊|安排[^。！？]{0,8}面诊|安排到院)/;
const NEGATED_APPOINTMENT = /(?:不想|不要|先不|暂缓|取消|别).{0,5}(?:预约|约|面诊)/;
const REFERENTIAL = /^(?:那|这|它|他|她|刚才|上面|继续|还有|下一步)|(?:呢[？?]?$|原理|恢复|疼|风险|几次|术后|上班|包含什么|什么时候|多久)/;
const VAGUE = /^(?:我想了解(?:一下)?|想了解(?:一下)?|有什么推荐|先看看|不知道选什么|都可以|你看着办|随便看看|有什么建议|我不确定|先介绍一下|不太确定|还没有头绪)[。！？!?]*$/;
const ACKNOWLEDGE = /^(?:好的?|嗯+|哦+|知道了|明白了|谢谢(?:你|您)?|不客气|先这样|我先看看|我考虑一下|行|可以|(?:先|就)(?:到这里|到这|聊到这里|聊到这|聊到这儿|到这吧|到这里吧))[呀啊哦呢～~！!。.，,\s]*$/;
const DEFERRAL = /(?:先|暂时|暂)(?:不|别)(?:预约|约了?|做)|不(?:着急|急着)(?:预约|约|做)|先不约/;
const PRODUCT_ATTRIBUTE_TERMS = /(?:型号|形态|光面|毛面|绒面|圆形|水滴|解剖型|规格|材质)/;
const PRODUCT_NAME = /(?:璀璨|曼托|傲诺拉|星熠|特贝茨|假体|瑞可丽|面膜)/;

const withIntent = (result, intent, reason) => {
  if (result.primary_intent === intent) return result;
  const tasks = result.tasks.map((task, index) => index === 0 ? { ...task, intent } : task);
  if (!tasks.some((task) => task.intent === intent)) tasks.unshift({ task_id:'t1', intent, evidence:String(result.tasks[0]?.evidence || '') });
  return { ...result, primary_intent:intent, tasks, reconciliation:{ from:result.primary_intent, to:intent, reason } };
};

export function reconcileRecognition(result, { message = "", router_state = {} } = {}) {
  if (!result?.primary_intent) return result;
  const text = String(message || "").trim();
  const intent = result.primary_intent;
  const topic = router_state?.current_topic || {};
  const entities = recognizeAcquisitionIntent(text).entities || {};
  const projects = entities.projects || [];
  const doctors = entities.doctors || [];
  const hasDoctor = doctors.length > 0 || Boolean(topic.doctor);
  const mentionedDoctor = DOCTOR_NAME.test(text) || doctors.length > 0;

  if (VAGUE.test(text) && !projects.length && !doctors.length) {
    return withIntent(result, "need_clarification", "vague_without_entity");
  }
  // “先不预约了/谢谢”是收尾，不是售前协调；有新项目/医生时仍按新问题处理。
  if (DEFERRAL.test(text) && !projects.length && !doctors.length && text.length <= 30) {
    return withIntent(result, "conversation_acknowledgement", "explicit_deferral");
  }
  if (ACKNOWLEDGE.test(text)) {
    return withIntent(result, "conversation_acknowledgement", "standalone_acknowledgement");
  }
  // 点名产品 + 型号/形态/材质等词，是产品属性核验，不能被目录或项目介绍吞掉。
  if (PRODUCT_ATTRIBUTE_TERMS.test(text) && PRODUCT_NAME.test(text)
    && !/(?:多少钱|价格|收费|报价)/.test(text) && intent !== "product_attribute_verification") {
    return withIntent(result, "product_attribute_verification", "product_attribute_terms");
  }
  if (APPOINTMENT_REQUEST.test(text) && !NEGATED_APPOINTMENT.test(text) && intent !== "appointment_request") {
    return withIntent(result, "appointment_request", "explicit_booking_phrase");
  }
  if (intent === "directory_discovery" && SERVICE.test(text) && !DIRECTORY.test(text)) {
    return withIntent(result, "service_information", "service_terms_without_directory");
  }
  if (intent === "service_information" && DIRECTORY.test(text) && !SERVICE.test(text)) {
    return withIntent(result, "directory_discovery", "directory_terms_without_service");
  }
  if (["product_attribute_verification", "price_verification", "directory_discovery"].includes(intent)
    && POLICY.test(text) && !PRODUCT_ATTRIBUTE.test(text)) {
    return withIntent(result, "policy_verification", "policy_terms_over_product_price");
  }
  if (intent === "product_attribute_verification" && projects.length && !PRODUCT_ATTRIBUTE.test(text)
    && /(?:介绍|了解|是什么|科普|怎么做)/.test(text)) {
    return withIntent(result, "project_explanation", "project_intro_without_attribute");
  }
  if (intent === "doctor_schedule_verification" && !mentionedDoctor && APPOINTMENT_TIME.test(text)) {
    return withIntent(result, "appointment_query", "appointment_time_without_named_doctor");
  }
  if (intent === "appointment_query" && mentionedDoctor && DOCTOR_SCHEDULE.test(text)) {
    return withIntent(result, "doctor_schedule_verification", "named_doctor_schedule");
  }
  // 点名医生问“做什么项目/擅长什么”是资料问题；只有“推荐/哪位”才是按项目找医生。
  if (intent === "doctor_discovery_by_project" && mentionedDoctor && !RECOMMEND_DOCTOR.test(text)) {
    return withIntent(result, "doctor_profile", "named_doctor_without_recommendation");
  }
  // 有当前项目时，“那大概什么时候能上班”是恢复追问，不是到院时间查询。
  if (intent === "appointment_query" && topic.project && !APPOINTMENT_TIME.test(text) && REFERENTIAL.test(text)) {
    return withIntent(result, "conversation_followup", "recovery_followup_not_appointment");
  }
  if (["project_explanation", "consultation_process", "product_attribute_verification", "service_information", "doctor_schedule_verification"].includes(intent)
    && topic.project && !projects.length && REFERENTIAL.test(text)) {
    return withIntent(result, "conversation_followup", "referential_followup");
  }
  return result;
}
