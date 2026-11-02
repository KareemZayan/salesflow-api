import { LeadSource } from '../../../generated/prisma/client';
import { LEAD_SCORE_WEIGHTS, LeadScoreWeights } from './lead-scoring.constants';
import { LeadScoringInput, SCORING_FIELDS, ScoringField } from './lead-scoring.strategy';
import {
  RuleBasedLeadScoringStrategy,
  computeRuleBasedScore,
} from './rule-based-lead-scoring.strategy';

const lead = (overrides: Partial<LeadScoringInput> = {}): LeadScoringInput => ({
  source: LeadSource.OTHER,
  email: null,
  phone: null,
  companyName: null,
  ...overrides,
});
const weights = (overrides: Partial<LeadScoreWeights> = {}): LeadScoreWeights => ({
  ...LEAD_SCORE_WEIGHTS,
  ...overrides,
});
const allSources = Object.values(LeadSource);

describe('RuleBasedLeadScoringStrategy', () => {
  const strategy = new RuleBasedLeadScoringStrategy();

  it('scores the source weight alone when no attribute is filled in', () => {
    for (const source of allSources) {
      expect(strategy.score(lead({ source }))).toBe(LEAD_SCORE_WEIGHTS.source[source]);
    }
  });

  it('every source has an explicit weight between 0 and 40', () => {
    expect(Object.keys(LEAD_SCORE_WEIGHTS.source).sort()).toEqual([...allSources].sort());
    for (const weight of Object.values(LEAD_SCORE_WEIGHTS.source)) {
      expect(weight).toBeGreaterThanOrEqual(0);
      expect(weight).toBeLessThanOrEqual(40);
    }
  });

  it('adds email +20, phone +15 and companyName +10', () => {
    expect(strategy.score(lead({ email: 'a@b.co' }))).toBe(20);
    expect(strategy.score(lead({ phone: '+20 100 123 4567' }))).toBe(15);
    expect(strategy.score(lead({ companyName: 'Acme' }))).toBe(10);
    expect(
      strategy.score(
        lead({ source: LeadSource.REFERRAL, email: 'a@b.co', phone: '12345', companyName: 'Acme' }),
      ),
    ).toBe(85);
  });

  it('gives no points for empty or whitespace-only values', () => {
    expect(strategy.score(lead({ email: '', phone: '   ', companyName: ' \t ' }))).toBe(0);
  });

  it('with the shipped weights no combination leaves 0-100', () => {
    for (const source of allSources) {
      for (const email of [null, 'a@b.co']) {
        for (const phone of [null, '12345']) {
          for (const companyName of [null, 'Acme']) {
            const score = strategy.score({ source, email, phone, companyName });
            expect(score).toBeGreaterThanOrEqual(0);
            expect(score).toBeLessThanOrEqual(100);
            expect(Number.isInteger(score)).toBe(true);
          }
        }
      }
    }
  });

  // The rules and the service share one list: a field in SCORING_FIELDS that changes nothing (or a
  // rule reading a field outside the list) would mean recomputing at the wrong times.
  it('every SCORING_FIELD changes the score, so the list matches what the rules read', () => {
    const filled = lead({
      source: LeadSource.REFERRAL,
      email: 'a@b.co',
      phone: '12345',
      companyName: 'Acme',
    });
    const withoutField: Record<ScoringField, LeadScoringInput> = {
      source: { ...filled, source: LeadSource.OTHER },
      email: { ...filled, email: null },
      phone: { ...filled, phone: null },
      companyName: { ...filled, companyName: null },
    };
    for (const field of SCORING_FIELDS) {
      expect(strategy.score(withoutField[field])).not.toBe(strategy.score(filled));
    }
  });
});

describe('computeRuleBasedScore clamp', () => {
  const full = lead({ source: LeadSource.REFERRAL, email: 'a@b.co', phone: '1', companyName: 'x' });

  it('never exceeds 100, even if the weights are raised', () => {
    const heavy = weights({
      source: { ...LEAD_SCORE_WEIGHTS.source, [LeadSource.REFERRAL]: 500 },
      email: 500,
    });
    expect(computeRuleBasedScore(full, heavy)).toBe(100);
  });

  it('never goes below 0, even if a weight is negative', () => {
    expect(computeRuleBasedScore(lead({ email: 'a@b.co' }), weights({ email: -500 }))).toBe(0);
  });

  it('keeps the exact boundary values 0 and 100', () => {
    const exactly100 = weights({
      source: { ...LEAD_SCORE_WEIGHTS.source, [LeadSource.REFERRAL]: 55 },
    });
    expect(computeRuleBasedScore(full, exactly100)).toBe(100);
    expect(computeRuleBasedScore(lead(), weights())).toBe(0);
  });

  it('rounds fractional weights to an integer (the column is an Int)', () => {
    expect(computeRuleBasedScore(lead({ email: 'a@b.co' }), weights({ email: 12.6 }))).toBe(13);
  });
});
