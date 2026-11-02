export const LEAD_CONVERTED_EVENT = 'lead.converted';

// Ids and the tenant only, no personal data: listeners load what they need through the services of
// the owning modules, with their own visibility rules. `dealId` is always null until Phase 10.
export interface LeadConvertedEvent {
  organizationId: string;
  leadId: string;
  contactId: string;
  companyId: string | null;
  dealId: string | null;
  ownerId: string;
  actorId: string;
  convertedAt: Date;
}
