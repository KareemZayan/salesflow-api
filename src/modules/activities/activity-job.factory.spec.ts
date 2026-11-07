import { ActivityType, DealStatus, LeadStatus } from '../../generated/prisma/client';
import { DealStageChangedEvent } from '../deals/events/deal-stage-changed.event';
import { LeadConvertedEvent } from '../leads/events/lead-converted.event';
import { LeadStatusChangedEvent } from '../leads/events/lead-status-changed.event';
import { LeadAssignedEvent } from '../leads/events/lead-assigned.event';
import {
  dealStageChangedJobs,
  leadAssignedJobs,
  leadConvertedJobs,
  leadStatusChangedJobs,
} from './activity-job.factory';

const at = new Date('2026-11-07T10:00:00.000Z');
const converted: LeadConvertedEvent = {
  organizationId: 'org',
  leadId: 'lead',
  contactId: 'contact',
  companyId: 'company',
  dealId: 'deal',
  ownerId: 'owner',
  actorId: 'actor',
  convertedAt: at,
};
const stageChanged: DealStageChangedEvent = {
  organizationId: 'org',
  dealId: 'deal',
  pipelineId: 'pipe',
  fromStageId: 's1',
  toStageId: 's2',
  status: DealStatus.OPEN,
  actorId: 'actor',
  changedAt: at,
};

describe('leadConvertedJobs', () => {
  it('makes one job per target: lead, contact, company and deal', () => {
    const jobs = leadConvertedJobs(converted);
    expect(jobs.map((job) => job.target)).toEqual([
      { kind: 'lead', id: 'lead' },
      { kind: 'contact', id: 'contact' },
      { kind: 'company', id: 'company' },
      { kind: 'deal', id: 'deal' },
    ]);
  });

  it('skips the company and the deal when the conversion has none', () => {
    const jobs = leadConvertedJobs({ ...converted, companyId: null, dealId: null });
    expect(jobs.map((job) => job.target.kind)).toEqual(['lead', 'contact']);
    expect(jobs[0].metadata).not.toHaveProperty('deal');
  });

  it('gives every target its own dedupe key, and the same event always the same keys', () => {
    const keys = leadConvertedJobs(converted).map((job) => job.dedupeKey);
    expect(new Set(keys).size).toBe(4);
    expect(leadConvertedJobs({ ...converted }).map((job) => job.dedupeKey)).toEqual(keys);
  });

  it('keeps deal data under one key so another timeline can withhold it', () => {
    for (const job of leadConvertedJobs(converted)) {
      expect(job.metadata.deal).toEqual({ dealId: 'deal' });
    }
  });

  it('carries the event time and the actor, with a static subject', () => {
    const [job] = leadConvertedJobs(converted);
    expect(job).toMatchObject({
      organizationId: 'org',
      actorId: 'actor',
      type: ActivityType.SYSTEM,
      subject: 'Lead converted',
      occurredAt: at.toISOString(),
    });
  });
});

describe('dealStageChangedJobs', () => {
  it('targets the deal and the contact and company it is linked to', () => {
    const jobs = dealStageChangedJobs(stageChanged, { contactId: 'c', companyId: 'co' });
    expect(jobs.map((job) => job.target)).toEqual([
      { kind: 'deal', id: 'deal' },
      { kind: 'contact', id: 'c' },
      { kind: 'company', id: 'co' },
    ]);
    expect(jobs.every((job) => job.type === ActivityType.STAGE_CHANGE)).toBe(true);
  });

  it('still gives the deal its own entry when it has no parties', () => {
    const jobs = dealStageChangedJobs(stageChanged, { contactId: null, companyId: null });
    expect(jobs.map((job) => job.target.kind)).toEqual(['deal']);
  });

  it('stores ids and enums only, all under the deal key; the subject names nothing', () => {
    const [job] = dealStageChangedJobs(stageChanged, { contactId: null, companyId: null });
    expect(job.subject).toBe('Deal stage changed');
    expect(job.metadata).toEqual({
      kind: 'deal.stage_changed',
      deal: { dealId: 'deal', fromStageId: 's1', toStageId: 's2', status: 'OPEN' },
    });
  });

  it('a second move of the same deal at another instant is a new fact (new keys)', () => {
    const first = dealStageChangedJobs(stageChanged, { contactId: 'c', companyId: null });
    const later = dealStageChangedJobs(
      { ...stageChanged, changedAt: new Date(at.getTime() + 1) },
      { contactId: 'c', companyId: null },
    );
    expect(later.map((j) => j.dedupeKey)).not.toEqual(first.map((j) => j.dedupeKey));
  });
});

describe('leadStatusChangedJobs / leadAssignedJobs', () => {
  it('records the statuses on the lead timeline only', () => {
    const event: LeadStatusChangedEvent = {
      organizationId: 'org',
      leadId: 'lead',
      from: LeadStatus.NEW,
      to: LeadStatus.CONTACTED,
      actorId: 'actor',
      changedAt: at,
    };
    const jobs = leadStatusChangedJobs(event);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].target).toEqual({ kind: 'lead', id: 'lead' });
    expect(jobs[0].metadata).toEqual({
      kind: 'lead.status_changed',
      from: 'NEW',
      to: 'CONTACTED',
    });
  });

  it('records the new and the previous owner', () => {
    const event: LeadAssignedEvent = {
      organizationId: 'org',
      leadId: 'lead',
      ownerId: 'new',
      previousOwnerId: null,
      actorId: 'actor',
      assignedAt: at,
    };
    expect(leadAssignedJobs(event)[0].metadata).toEqual({
      kind: 'lead.assigned',
      ownerId: 'new',
      previousOwnerId: null,
    });
  });
});

describe('every job', () => {
  it('has a key BullMQ accepts as a job id (no colon) and a JSON-safe payload', () => {
    const jobs = [
      ...leadConvertedJobs(converted),
      ...dealStageChangedJobs(stageChanged, { contactId: 'c', companyId: 'co' }),
    ];
    for (const job of jobs) {
      expect(job.dedupeKey).not.toContain(':');
      expect(JSON.parse(JSON.stringify(job))).toEqual(job);
    }
  });
});
