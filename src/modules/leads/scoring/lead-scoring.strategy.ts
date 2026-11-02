import { Lead } from '../../../generated/prisma/client';

// The ONLY list of lead attributes that feed the score. The service uses it to decide whether an
// update needs a recomputation (and the lead lock), and `LeadScoringInput` is derived from it, so
// the two cannot drift apart. A strategy must read nothing outside this list.
export const SCORING_FIELDS = ['source', 'email', 'phone', 'companyName'] as const;
export type ScoringField = (typeof SCORING_FIELDS)[number];
export type LeadScoringInput = Pick<Lead, ScoringField>;

// Strategy pattern: how a lead is scored is swappable (rule-based now, something else later)
// without touching the service. Pure and synchronous: no I/O, so it can run inside a transaction.
export interface LeadScoringStrategy {
  score(input: LeadScoringInput): number;
}

export const LEAD_SCORING_STRATEGY = Symbol('LEAD_SCORING_STRATEGY');
