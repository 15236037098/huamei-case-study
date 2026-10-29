import { createHash } from "node:crypto";
import { splitAcquisitionReplySegments } from "../acquisition-conversation-style.mjs";
import { independentAnswerCategory } from "./intent-policy.mjs";

// The public browser and persisted history must share one stable assistant
// message identity. It intentionally mirrors the session-store key.
export function assistantMessageIdFor(sessionId, inboundMessageId) {
  return `reply_${createHash("sha256")
    .update(`${sessionId}\u0000${inboundMessageId}\u0000assistant`)
    .digest("hex")}`;
}

export function knownProjectsFrom(result = {}) {
  return [...new Set([
    ...(result.output?.structured_data?.projects || []),
    result.output?.structured_data?.project,
    ...(result.output?.structured_data?.intent_analysis?.entities?.projects || []),
    ...(result.output?.structured_data?.knowledge_hits || []).map((item) => item.project)
  ].filter(Boolean))].slice(0, 6);
}

export function buildReplyPayload({ text = "", structuredData = {}, citations = [], media = [] } = {}) {
  const independentCategory = independentAnswerCategory(structuredData);
  return {
    text,
    segments:splitAcquisitionReplySegments(text),
    independent_segments:splitAcquisitionReplySegments(structuredData?.independent_contact_answer || "")
      .map((content) => ({ type:"independent_answer", category:independentCategory, content }))
      .filter((item) => item.category),
    citations,
    media,
    suggestions:structuredData?.next_questions || []
  };
}
