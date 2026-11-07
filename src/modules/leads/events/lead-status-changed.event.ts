import { LeadStatus } from '../../../generated/prisma/client';

export const LEAD_STATUS_CHANGED_EVENT = 'lead.status_changed';

// Published after the commit of a status change whose compare-and-set matched, never for a rejected
// or lost one. Ids and the two statuses only. It replaces the LeadStatusHistory table that 8b
// deferred: the Activities timeline keeps the who / from / to / when.
export interface LeadStatusChangedEvent {
  organizationId: string;
  leadId: string;
  from: LeadStatus;
  to: LeadStatus;
  actorId: string;
  changedAt: Date;
}
