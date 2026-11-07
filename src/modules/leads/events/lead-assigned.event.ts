export const LEAD_ASSIGNED_EVENT = 'lead.assigned';

// Published after the commit, only when a lead gets a NEW owner who is not the person doing it: on
// create for someone else, or when a PATCH really changes the owner (re-sending the current owner
// publishes nothing). Never published by lead conversion. Ids and the tenant only: no lead content,
// so a listener loads what it needs under its own rules.
export interface LeadAssignedEvent {
  organizationId: string;
  leadId: string;
  // The NEW owner: the person to notify.
  ownerId: string;
  // Null when the lead has just been created.
  previousOwnerId: string | null;
  actorId: string;
  assignedAt: Date;
}
