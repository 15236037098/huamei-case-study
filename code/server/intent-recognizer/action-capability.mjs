import { MODEL_PROPOSABLE_INTENTS } from './schema.mjs';

const PROPOSAL_ONLY = new Set(['appointment_request']);

// A-01's router never has a business-write execution target.
export function resolveTaskCapability(intent) {
  if (!MODEL_PROPOSABLE_INTENTS.includes(intent)) return 'refused';
  return PROPOSAL_ONLY.has(intent) ? 'proposal_candidate' : 'answer_ready';
}
