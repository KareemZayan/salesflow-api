import { LeadSource } from '../../../generated/prisma/client';

export const LEAD_SCORE_MIN = 0;
export const LEAD_SCORE_MAX = 100;

export interface LeadScoreWeights {
  // Every source has an explicit weight: adding a LeadSource value fails typecheck until it gets one.
  source: Record<LeadSource, number>;
  // Points for a filled-in attribute.
  email: number;
  phone: number;
  companyName: number;
}

// Adjustable defaults, not business law (ADR 0008). Referrals and partners convert best, cold calls
// worst. The best case today is 40 + 20 + 15 + 10 = 85; the clamp keeps any future re-weighting
// inside 0-100 regardless.
export const LEAD_SCORE_WEIGHTS: LeadScoreWeights = {
  source: {
    [LeadSource.REFERRAL]: 40,
    [LeadSource.PARTNER]: 35,
    [LeadSource.WEBSITE]: 30,
    [LeadSource.EVENT]: 25,
    [LeadSource.EMAIL_CAMPAIGN]: 20,
    [LeadSource.SOCIAL_MEDIA]: 15,
    [LeadSource.COLD_CALL]: 10,
    [LeadSource.OTHER]: 0,
  },
  email: 20,
  phone: 15,
  companyName: 10,
};
