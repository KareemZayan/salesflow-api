import { DealStatus, NotificationType } from '../../generated/prisma/client';
import { DealStageChangedEvent } from '../deals/events/deal-stage-changed.event';
import { LeadAssignedEvent } from '../leads/events/lead-assigned.event';
import { LeadConvertedEvent } from '../leads/events/lead-converted.event';
import { TaskAssignedEvent } from '../tasks/events/task-assigned.event';
import {
  dealStageChangedJob,
  leadAssignedJob,
  leadConvertedJob,
  taskAssignedJob,
  taskDueSoonJob,
  taskOverdueJob,
} from './notification-job.factory';

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

describe('scheduled task alerts', () => {
  const subject = { organizationId: ORG, taskId: 'task-1', assigneeId: 'rep' };

  it('builds a TASK_DUE_SOON job for the assignee, keyed on the reminder instant', () => {
    expect(taskDueSoonJob({ ...subject, reminderAt: AT })).toEqual({
      organizationId: ORG,
      userId: 'rep',
      type: NotificationType.TASK_DUE_SOON,
      title: 'A task is coming up',
      body: null,
      data: { taskId: 'task-1' },
      dedupeKey: `task.reminder-task-1-${AT.getTime()}`,
    });
  });

  it('builds a TASK_OVERDUE job for the assignee, keyed on the due instant', () => {
    expect(taskOverdueJob({ ...subject, dueDate: AT })).toMatchObject({
      type: NotificationType.TASK_OVERDUE,
      userId: 'rep',
      dedupeKey: `task.overdue-task-1-${AT.getTime()}`,
    });
  });

  it('a moved reminder or due date is a new fact: a different key', () => {
    const later = new Date(AT.getTime() + 60_000);
    expect(taskDueSoonJob({ ...subject, reminderAt: later }).dedupeKey).not.toBe(
      taskDueSoonJob({ ...subject, reminderAt: AT }).dedupeKey,
    );
    expect(taskOverdueJob({ ...subject, dueDate: later }).dedupeKey).not.toBe(
      taskOverdueJob({ ...subject, dueDate: AT }).dedupeKey,
    );
  });

  it('keys contain no colon (BullMQ rejects it in a job id)', () => {
    expect(taskDueSoonJob({ ...subject, reminderAt: AT }).dedupeKey).not.toContain(':');
    expect(taskOverdueJob({ ...subject, dueDate: AT }).dedupeKey).not.toContain(':');
  });
});

describe('lead assigned', () => {
  const event = (overrides: Partial<LeadAssignedEvent> = {}): LeadAssignedEvent => ({
    organizationId: ORG,
    leadId: 'lead-1',
    ownerId: 'rep',
    previousOwnerId: 'other',
    actorId: 'admin',
    assignedAt: AT,
    ...overrides,
  });

  it('notifies the NEW owner with the lead id and a deterministic key', () => {
    expect(leadAssignedJob(event())).toEqual({
      organizationId: ORG,
      userId: 'rep',
      type: NotificationType.LEAD_ASSIGNED,
      title: 'A lead was assigned to you',
      body: null,
      data: { leadId: 'lead-1' },
      dedupeKey: `lead.assigned-lead-1-${AT.getTime()}`,
    });
  });

  it('never notifies the actor about their own action', () => {
    expect(leadAssignedJob(event({ ownerId: 'admin', actorId: 'admin' }))).toBeNull();
  });
});

// Job payloads travel through Redis and are visible in Bull Board and in failed jobs, so they carry
// ids and the tenant only: never an email, a name or any free text. Every factory is run over the
// same fixtures, whose ids are UUIDs; the static titles are the only prose a job may hold.
describe('notification job payloads hold no personal data', () => {
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const ids = { org: uuid(1), actor: uuid(2), owner: uuid(3), subject: uuid(4), other: uuid(5) };
  const STATIC_TITLES = new Set([
    'A task was assigned to you',
    'A lead was assigned to you',
    'One of your leads was converted',
    'One of your deals was won',
    'One of your deals was lost',
    'One of your deals changed stage',
    'A task is coming up',
    'A task is overdue',
  ]);
  const jobs = [
    taskAssignedJob({
      organizationId: ids.org,
      taskId: ids.subject,
      assigneeId: ids.owner,
      previousAssigneeId: null,
      actorId: ids.actor,
      assignedAt: AT,
    }),
    leadAssignedJob({
      organizationId: ids.org,
      leadId: ids.subject,
      ownerId: ids.owner,
      previousOwnerId: null,
      actorId: ids.actor,
      assignedAt: AT,
    }),
    leadConvertedJob({
      organizationId: ids.org,
      leadId: ids.subject,
      contactId: ids.other,
      companyId: null,
      dealId: null,
      ownerId: ids.owner,
      actorId: ids.actor,
      convertedAt: AT,
    }),
    ...[DealStatus.OPEN, DealStatus.WON, DealStatus.LOST].map((status) =>
      dealStageChangedJob(
        {
          organizationId: ids.org,
          dealId: ids.subject,
          pipelineId: ids.other,
          fromStageId: ids.other,
          toStageId: ids.other,
          status,
          actorId: ids.actor,
          changedAt: AT,
        },
        ids.owner,
      ),
    ),
    taskDueSoonJob({
      organizationId: ids.org,
      taskId: ids.subject,
      assigneeId: ids.owner,
      reminderAt: AT,
    }),
    taskOverdueJob({
      organizationId: ids.org,
      taskId: ids.subject,
      assigneeId: ids.owner,
      dueDate: AT,
    }),
  ];

  it('covers every notification type the factories can produce', () => {
    expect(new Set(jobs.map((job) => job?.type)).size).toBe(8);
  });

  it.each(jobs.map((job, index) => [job?.type ?? `job ${index}`, job] as const))(
    '%s: ids and the tenant only, a static title and no body',
    (_name, job) => {
      expect(job).not.toBeNull();
      if (!job) return;
      expect(Object.keys(job).sort()).toEqual(
        ['body', 'data', 'dedupeKey', 'organizationId', 'title', 'type', 'userId'].sort(),
      );
      expect(job.body).toBeNull();
      expect(STATIC_TITLES.has(job.title)).toBe(true);
      // `data` is a flat map whose every value is an id (a UUID here).
      for (const value of Object.values(job.data)) {
        expect(value).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
      }
      expect(JSON.stringify(job)).not.toContain('@');
    },
  );
});
