import { TransitionMap } from '../../common/utils/status-transition.util';
import { LeadStatus } from '../../generated/prisma/client';

// What a lead may move to through POST /leads/:id/status. CONVERTED is a terminal state that only
// lead conversion (Phase 9) may set, so nothing leads to it and it leads nowhere. A reopened
// (UNQUALIFIED) lead returns to CONTACTED: it has already been contacted, and it must be
// re-qualified, not silently restored to QUALIFIED (ADR 0008).
export const LEAD_STATUS_TRANSITIONS: TransitionMap<LeadStatus> = {
  [LeadStatus.NEW]: [LeadStatus.CONTACTED, LeadStatus.UNQUALIFIED],
  [LeadStatus.CONTACTED]: [LeadStatus.QUALIFIED, LeadStatus.UNQUALIFIED],
  [LeadStatus.QUALIFIED]: [LeadStatus.UNQUALIFIED],
  [LeadStatus.UNQUALIFIED]: [LeadStatus.CONTACTED],
  [LeadStatus.CONVERTED]: [],
};

// The statuses a client may ask for: everything except CONVERTED.
export const SETTABLE_LEAD_STATUSES: readonly LeadStatus[] = Object.values(LeadStatus).filter(
  (status) => status !== LeadStatus.CONVERTED,
);
