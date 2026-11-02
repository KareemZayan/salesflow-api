import { Injectable } from '@nestjs/common';
import {
  LEAD_SCORE_MAX,
  LEAD_SCORE_MIN,
  LEAD_SCORE_WEIGHTS,
  LeadScoreWeights,
} from './lead-scoring.constants';
import { LeadScoringInput, LeadScoringStrategy } from './lead-scoring.strategy';

// Blank counts as missing: no points for an empty or whitespace-only value, whoever wrote the row.
const hasValue = (value: string | null): boolean => value !== null && value.trim() !== '';

// A plain function so tests can try other weights (clamp, boundaries) without touching DI.
export function computeRuleBasedScore(input: LeadScoringInput, weights: LeadScoreWeights): number {
  const raw =
    weights.source[input.source] +
    (hasValue(input.email) ? weights.email : 0) +
    (hasValue(input.phone) ? weights.phone : 0) +
    (hasValue(input.companyName) ? weights.companyName : 0);
  return Math.min(LEAD_SCORE_MAX, Math.max(LEAD_SCORE_MIN, Math.round(raw)));
}

@Injectable()
export class RuleBasedLeadScoringStrategy implements LeadScoringStrategy {
  score(input: LeadScoringInput): number {
    return computeRuleBasedScore(input, LEAD_SCORE_WEIGHTS);
  }
}
