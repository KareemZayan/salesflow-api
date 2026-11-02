import { DealStatus, NotificationType } from '../../generated/prisma/client';
import { DealStageChangedEvent } from '../deals/events/deal-stage-changed.event';
import { LeadConvertedEvent } from '../leads/events/lead-converted.event';
import { TaskAssignedEvent } from '../tasks/events/task-assigned.event';
import { dealStageChangedJob, leadConvertedJob, taskAssignedJob } from './notification-job.factory';

const AT = new Date('2026-11-02T10:00:00.000Z');
const ORG = 'org-1';

const taskEvent = (overrides: Partial<TaskAssignedEvent> = {}): TaskAssignedEvent => ({
  organizationId: ORG,
  taskId: 'task-1',
  assigneeId: 'rep',
  previousAssigneeId: null,
  actorId: 'admin',
  assignedAt: AT,
  ...overrides,
});
const leadEvent = (overrides: Partial<LeadConvertedEvent> = {}): LeadConvertedEvent => ({
  organizationId: ORG,
  leadId: 'lead-1',
  contactId: 'contact-1',
  companyId: null,
  dealId: null,
  ownerId: 'rep',
  actorId: 'admin',
  convertedAt: AT,
  ...overrides,
});
const dealEvent = (overrides: Partial<DealStageChangedEvent> = {}): DealStageChangedEvent => ({
  organizationId: ORG,
  dealId: 'deal-1',
  pipelineId: 'p',
  fromStageId: 's1',
  toStageId: 's2',
  status: DealStatus.OPEN,
  actorId: 'admin',
  changedAt: AT,
  ...overrides,
});

describe('notification job factory', () => {
  it('notifies the assignee about a task, with the record id and a deterministic key', () => {
    expect(taskAssignedJob(taskEvent())).toEqual({
      organizationId: ORG,
      userId: 'rep',
      type: NotificationType.TASK_ASSIGNED,
      title: 'A task was assigned to you',
      body: null,
      data: { taskId: 'task-1' },
      dedupeKey: `task.assigned-task-1-${AT.getTime()}`,
    });
  });

  it('never notifies someone about their own action', () => {
    expect(taskAssignedJob(taskEvent({ assigneeId: 'admin' }))).toBeNull();
    expect(leadConvertedJob(leadEvent({ ownerId: 'admin' }))).toBeNull();
    expect(dealStageChangedJob(dealEvent(), 'admin')).toBeNull();
  });

  it('notifies the lead owner about a conversion', () => {
    expect(leadConvertedJob(leadEvent())).toMatchObject({
      userId: 'rep',
      type: NotificationType.LEAD_CONVERTED,
      data: { leadId: 'lead-1', contactId: 'contact-1' },
      dedupeKey: `lead.converted-lead-1-${AT.getTime()}`,
    });
  });

  it.each([
    [DealStatus.OPEN, NotificationType.DEAL_STAGE_CHANGED],
    [DealStatus.WON, NotificationType.DEAL_WON],
    [DealStatus.LOST, NotificationType.DEAL_LOST],
  ])('maps a deal move to %s onto %s for the deal owner', (status, type) => {
    expect(dealStageChangedJob(dealEvent({ status }), 'rep')).toMatchObject({
      userId: 'rep',
      type,
      data: { dealId: 'deal-1', toStageId: 's2' },
    });
  });

  it('gives two moves of one deal different keys, and a repeated event the same key', () => {
    const first = dealStageChangedJob(dealEvent(), 'rep');
    const repeated = dealStageChangedJob(dealEvent(), 'rep');
    const later = dealStageChangedJob(dealEvent({ changedAt: new Date(AT.getTime() + 1) }), 'rep');
    expect(repeated?.dedupeKey).toBe(first?.dedupeKey);
    expect(later?.dedupeKey).not.toBe(first?.dedupeKey);
  });

  it('builds keys BullMQ accepts as job ids (no colon)', () => {
    for (const job of [taskAssignedJob(taskEvent()), leadConvertedJob(leadEvent())]) {
      expect(job?.dedupeKey).not.toContain(':');
    }
  });
});
