import { createHash } from "node:crypto";
import { z } from "zod";

export const AUDIT_STAGES = Object.freeze(["intent", "answer", "handover", "delivery"]);
export const AUDIT_STATUSES = Object.freeze(["completed", "skipped", "handover", "blocked", "failed"]);

export const OrchestrationAuditEventSchema = z.object({
  event_id:z.string().min(1),
  turn_id:z.string().min(1),
  sequence:z.number().int().nonnegative(),
  stage:z.enum(AUDIT_STAGES),
  status:z.enum(AUDIT_STATUSES),
  at:z.string().datetime(),
  data:z.record(z.string(), z.unknown()).default({})
});

export const OrchestrationAuditStreamSchema = z.array(OrchestrationAuditEventSchema);

export function turnIdFor(envelope = {}) {
  const tenant = String(envelope.tenant_id || "");
  const channel = String(envelope.channel || "");
  const conversation = String(envelope.conversation_id || "");
  const message = String(envelope.message?.id || "");
  return `turn_${createHash("sha256")
    .update(`${tenant}\u0000${channel}\u0000${conversation}\u0000${message}`)
    .digest("hex")
    .slice(0, 24)}`;
}

export function createAuditEvent({ turnId, stage, status, data = {}, at = new Date().toISOString(), sequence = 0 }) {
  return OrchestrationAuditEventSchema.parse({
    event_id:`aud_${createHash("sha256")
      .update(`${turnId}\u0000${stage}\u0000${sequence}\u0000${at}`)
      .digest("hex")
      .slice(0, 24)}`,
    turn_id:turnId,
    sequence,
    stage,
    status,
    at,
    data
  });
}

export function appendAuditEvent(stream = [], event) {
  const parsed = OrchestrationAuditEventSchema.parse(event);
  return [...stream, parsed];
}

// Replay is a pure fold over the validated stream. It deliberately does not
// re-run model or business side effects: operators can reconstruct the exact
// stage outcome from the event log alone.
export function replayAuditEvents(stream = []) {
  const events = OrchestrationAuditStreamSchema.parse(stream);
  const state = {
    turn_id:events[0]?.turn_id || null,
    stages:{},
    handover_required:false,
    answer_ready:false,
    delivery_mode:null
  };
  for (const event of events) {
    state.stages[event.stage] = event.status;
    if (event.stage === "intent" && event.data?.handover_required === true) state.handover_required = true;
    if (event.stage === "handover") state.handover_required = event.status === "handover";
    if (event.stage === "answer" && event.status === "completed") state.answer_ready = true;
    if (event.stage === "delivery") state.delivery_mode = event.data?.mode || null;
  }
  return state;
}
