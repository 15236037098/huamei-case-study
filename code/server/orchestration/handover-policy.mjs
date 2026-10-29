import { z } from "zod";
import { tenantScopedKey } from "../platform/tenant-context.mjs";
import { assistantMessageIdFor } from "./answer-policy.mjs";

export const HandoverDecisionSchema = z.object({
  required:z.boolean(),
  suspended:z.boolean(),
  pending:z.boolean(),
  status:z.string().nullable(),
  reason:z.string().nullable(),
  team:z.string().nullable(),
  assignee:z.string().nullable()
});

export function isHandoverSuspended(openHandover) {
  return Boolean(openHandover && (openHandover.ai_suspended === true || openHandover.status === "active"));
}

export function selectPendingHandover({ openHandover, handoverSuspended, handoverTask } = {}) {
  if (openHandover && !handoverSuspended) return openHandover;
  if (handoverTask?.status === "pending" && handoverTask.ai_suspended !== true) return handoverTask;
  return null;
}

export function evaluateHandoverPolicy({ openHandover, handoverTask, result } = {}) {
  const suspended = isHandoverSuspended(openHandover);
  const pending = selectPendingHandover({ openHandover, handoverSuspended:suspended, handoverTask });
  const source = pending || openHandover || result?.output?.handover || {};
  return HandoverDecisionSchema.parse({
    required:Boolean(source.required || openHandover || handoverTask),
    suspended,
    pending:Boolean(pending),
    status:source.status ? String(source.status) : null,
    reason:source.reason ? String(source.reason) : null,
    team:source.to_team || source.team ? String(source.to_team || source.team) : null,
    assignee:source.assignee ? String(source.assignee) : null
  });
}

export function handoverMetadata(openHandover) {
  return {
    required:true,
    id:openHandover.id,
    task_id:openHandover.task_id,
    status:openHandover.status,
    to_team:openHandover.team,
    reason:openHandover.reason,
    assignee:openHandover.assignee,
    sla_due_at:openHandover.sla_due_at
  };
}

export function handoverResponse(envelope, openHandover, metadata = {}) {
  const tenantId = envelope.tenant_id;
  const channel = envelope.channel;
  const externalConversationId = envelope.conversation_id;
  const message = envelope.message.text;
  const claimed = openHandover.ai_suspended === true || openHandover.status === "active";
  const handoverSessionId = tenantScopedKey(tenantId, channel, externalConversationId);
  return {
    schema_version:"1.1",
    service:"presales-acquisition-agent",
    tenant_id:tenantId,
    request_id:metadata.requestId,
    run_id:null,
    status:claimed ? "human_active" : "handover_pending",
    channel,
    conversation_id:externalConversationId,
    message_id:envelope.message.id,
    assistant_message_id:claimed ? null : assistantMessageIdFor(handoverSessionId, envelope.message.id),
    agent:{ id:"A-01", slug:"acquisition-consultant", name:"AI获客顾问·小美", version:"5.9.0" },
    reply:{
      text:claimed ? "" : "已为您转接人工顾问，正在接入中。",
      segments:claimed ? [] : ["已为您转接人工顾问，正在接入中。"],
      citations:[],
      media:[],
      suggestions:[]
    },
    handover:handoverMetadata(openHandover),
    delivery:{ suppress_ai:claimed, mode:claimed ? "human_only" : "handover_notice" },
    profile_signals:{
      projects:openHandover.projects || [],
      known_slots:openHandover.known_slots || {},
      conversation_summary:openHandover.summary,
      turn_count:null,
      session_id:externalConversationId,
      intent:"human_handover"
    },
    lead_capture:{ should_prompt:false },
    guardrails:{
      medical_diagnosis_allowed:false,
      suitability_judgement_allowed:false,
      llm_used:false,
      compliance_gate_version:"4.2.0",
      knowledge_version:null
    },
    usage:{
      provider:"handover_orchestrator",
      model:null,
      input_characters:message.length,
      output_characters:claimed ? 0 : 17
    }
  };
}
