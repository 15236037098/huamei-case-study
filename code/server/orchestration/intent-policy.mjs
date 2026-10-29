import { z } from "zod";

export const SAFE_INDEPENDENT_INTENTS = Object.freeze([
  "project_explanation",
  "project_comparison",
  "project_discovery_by_concern",
  "product_attribute_verification",
  "price_verification",
  "policy_verification",
  "service_information"
]);

// Rule table first: adding an independent-answer intent or follow-up facet is
// a data change, not another branch in the domain service.
export const INDEPENDENT_ANSWER_RULES = Object.freeze([
  {
    id:"safe_independent_intent",
    match:({ intent }) => SAFE_INDEPENDENT_INTENTS.includes(intent),
    category:({ intent }) => intent
  },
  {
    id:"recovery_followup",
    match:({ intent, facet }) => intent === "conversation_followup" && facet === "recovery",
    category:() => "recovery"
  }
]);

export const IntentPolicySchema = z.object({
  intent:z.string(),
  independent_category:z.string(),
  handover_required:z.boolean(),
  handover_reason:z.string().nullable(),
  risk_level:z.string().nullable(),
  risk_categories:z.array(z.string())
});

export function independentAnswerCategory(structuredData = {}) {
  const intent = String(structuredData?.intent || "");
  const facet = structuredData?.intent_analysis?.entities?.requested_facet || "";
  const rule = INDEPENDENT_ANSWER_RULES.find((candidate) => candidate.match({ intent, facet }));
  return rule ? rule.category({ intent, facet }) : "";
}

export function evaluateIntentPolicy({ result = {}, message = "" } = {}) {
  const structured = result?.output?.structured_data || {};
  const riskMatches = Array.isArray(structured.risk_matches) ? structured.risk_matches : [];
  const handoverRequired = result?.status === "handover_required"
    || structured?.handover?.required === true
    || structured?.intent_analysis?.handover_required === true;
  const handoverReason = structured?.handover?.reason
    || structured?.intent_analysis?.handover_reason
    || riskMatches[0]?.category
    || (handoverRequired ? "policy_handover" : null);
  return IntentPolicySchema.parse({
    intent:String(structured.intent || structured.intent_analysis?.primary_intent || ""),
    independent_category:independentAnswerCategory(structured),
    handover_required:handoverRequired,
    handover_reason:handoverReason ? String(handoverReason) : null,
    risk_level:String(structured.risk_level || riskMatches[0]?.level || "") || null,
    risk_categories:[...new Set(riskMatches.map((item) => String(item?.category || "")).filter(Boolean))]
  });
}
