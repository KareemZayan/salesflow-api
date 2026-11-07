import { ActivityType } from '../../generated/prisma/client';
import { DealStageChangedEvent } from '../deals/events/deal-stage-changed.event';
import { LeadAssignedEvent } from '../leads/events/lead-assigned.event';
import { LeadConvertedEvent } from '../leads/events/lead-converted.event';
import { LeadStatusChangedEvent } from '../leads/events/lead-status-changed.event';
import { ACTIVITY_SUBJECTS, DEAL_METADATA_KEY } from './activities.constants';
import { ActivityMetadata, CreateActivityJob } from './activity-job';
import { ActivityParent } from './activity-parent';

// Factory: domain event -> timeline jobs, one per target record. Pure, so wording, metadata and keys
// are unit-tested without Redis. Subjects are static and metadata holds ids only: no name, title or
// amount ever reaches a stored entry (ADR 0013).
//
// Keys use "." and "-" only: BullMQ rejects ":" in a custom job id, and the key is reused as one.
const key = (event: string, subjectId: string, at: Date, target: ActivityParent): string =>
  `${event}-${subjectId}-${at.getTime()}-${target.kind}-${target.id}`;

interface Fact {
  event: string;
  subjectId: string;
  organizationId: string;
  actorId: string;
  at: Date;
  type: ActivityType;
  subject: string;
  metadata: ActivityMetadata;
}

function jobsFor(fact: Fact, targets: ActivityParent[]): CreateActivityJob[] {
  return targets.map((target) => ({
    organizationId: fact.organizationId,
    actorId: fact.actorId,
    type: fact.type,
    subject: fact.subject,
    metadata: fact.metadata,
    occurredAt: fact.at.toISOString(),
    target,
    dedupeKey: key(fact.event, fact.subjectId, fact.at, target),
  }));
}

const present = (targets: (ActivityParent | null)[]): ActivityParent[] =>
  targets.filter((target): target is ActivityParent => target !== null);

const maybe = (kind: ActivityParent['kind'], id: string | null): ActivityParent | null =>
  id ? { kind, id } : null;

export function leadConvertedJobs(event: LeadConvertedEvent): CreateActivityJob[] {
  return jobsFor(
    {
      event: 'lead.converted',
      subjectId: event.leadId,
      organizationId: event.organizationId,
      actorId: event.actorId,
      at: event.convertedAt,
      type: ActivityType.SYSTEM,
      subject: ACTIVITY_SUBJECTS.LEAD_CONVERTED,
      metadata: {
        kind: 'lead.converted',
        leadId: event.leadId,
        contactId: event.contactId,
        companyId: event.companyId,
        ...(event.dealId && { [DEAL_METADATA_KEY]: { dealId: event.dealId } }),
      },
    },
    present([
      { kind: 'lead', id: event.leadId },
      { kind: 'contact', id: event.contactId },
      maybe('company', event.companyId),
      maybe('deal', event.dealId),
    ]),
  );
}

export function leadStatusChangedJobs(event: LeadStatusChangedEvent): CreateActivityJob[] {
  return jobsFor(
    {
      event: 'lead.status_changed',
      subjectId: event.leadId,
      organizationId: event.organizationId,
      actorId: event.actorId,
      at: event.changedAt,
      type: ActivityType.SYSTEM,
      subject: ACTIVITY_SUBJECTS.LEAD_STATUS_CHANGED,
      metadata: { kind: 'lead.status_changed', from: event.from, to: event.to },
    },
    [{ kind: 'lead', id: event.leadId }],
  );
}

export function leadAssignedJobs(event: LeadAssignedEvent): CreateActivityJob[] {
  return jobsFor(
    {
      event: 'lead.assigned',
      subjectId: event.leadId,
      organizationId: event.organizationId,
      actorId: event.actorId,
      at: event.assignedAt,
      type: ActivityType.SYSTEM,
      subject: ACTIVITY_SUBJECTS.LEAD_ASSIGNED,
      metadata: {
        kind: 'lead.assigned',
        ownerId: event.ownerId,
        previousOwnerId: event.previousOwnerId,
      },
    },
    [{ kind: 'lead', id: event.leadId }],
  );
}

// A deal's stage move belongs on the deal AND on the contact and company it is linked to (the event
// carries neither, so the caller looks them up). Everything about the deal sits under one key so a
// timeline of the contact or company can withhold it from someone who cannot see the deal.
export function dealStageChangedJobs(
  event: DealStageChangedEvent,
  parties: { contactId: string | null; companyId: string | null },
): CreateActivityJob[] {
  return jobsFor(
    {
      event: 'deal.stage_changed',
      subjectId: event.dealId,
      organizationId: event.organizationId,
      actorId: event.actorId,
      at: event.changedAt,
      type: ActivityType.STAGE_CHANGE,
      subject: ACTIVITY_SUBJECTS.DEAL_STAGE_CHANGED,
      metadata: {
        kind: 'deal.stage_changed',
        [DEAL_METADATA_KEY]: {
          dealId: event.dealId,
          fromStageId: event.fromStageId,
          toStageId: event.toStageId,
          status: event.status,
        },
      },
    },
    present([
      { kind: 'deal', id: event.dealId },
      maybe('contact', parties.contactId),
      maybe('company', parties.companyId),
    ]),
  );
}
