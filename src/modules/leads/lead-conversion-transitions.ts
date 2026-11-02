import { TransitionMap } from '../../common/utils/status-transition.util';
import { LeadStatus } from '../../generated/prisma/client';

// Conversion is the only way to reach CONVERTED, and only from QUALIFIED (ADR 0008). Upgrade path:
// to also convert a CONTACTED lead, add CONVERTED to that entry; nothing else changes.
export const LEAD_CONVERSION_TRANSITIONS: TransitionMap<LeadStatus> = {
  [LeadStatus.NEW]: [],
  [LeadStatus.CONTACTED]: [],
  [LeadStatus.QUALIFIED]: [LeadStatus.CONVERTED],
  [LeadStatus.UNQUALIFIED]: [],
  [LeadStatus.CONVERTED]: [],
};
