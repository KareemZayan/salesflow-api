import { DealStageChangedEvent } from '../deals/events/deal-stage-changed.event';
import { LeadAssignedEvent } from '../leads/events/lead-assigned.event';
import { LeadConvertedEvent } from '../leads/events/lead-converted.event';
import { TaskAssignedEvent } from '../tasks/events/task-assigned.event';
import { NotificationType } from '../../generated/prisma/client';
import { CreateNotificationJob } from './notification-job';

// Factory: domain event -> notification job. Pure, so the wording and the keys are unit-tested
// without Redis. A person is never notified about their own action (`null`).
//
// Keys use "." and "-" only: BullMQ rejects ":" in a custom job id, and the key is reused as one.
const key = (event: string, subjectId: string, at: Date): string =>
  `${event}-${subjectId}-${at.getTime()}`;

export function taskAssignedJob(event: TaskAssignedEvent): CreateNotificationJob | null {
  if (event.assigneeId === event.actorId) return null;
  return {
    organizationId: event.organizationId,
    userId: event.assigneeId,
    type: NotificationType.TASK_ASSIGNED,
    title: 'A task was assigned to you',
    body: null,
    data: { taskId: event.taskId },
    dedupeKey: key('task.assigned', event.taskId, event.assignedAt),
  };
}

export function leadAssignedJob(event: LeadAssignedEvent): CreateNotificationJob | null {
  if (event.ownerId === event.actorId) return null;
  return {
    organizationId: event.organizationId,
    userId: event.ownerId,
    type: NotificationType.LEAD_ASSIGNED,
    title: 'A lead was assigned to you',
    body: null,
    data: { leadId: event.leadId },
    dedupeKey: key('lead.assigned', event.leadId, event.assignedAt),
  };
}

export function leadConvertedJob(event: LeadConvertedEvent): CreateNotificationJob | null {
  if (event.ownerId === event.actorId) return null;
  return {
    organizationId: event.organizationId,
    userId: event.ownerId,
    type: NotificationType.LEAD_CONVERTED,
    title: 'One of your leads was converted',
    body: null,
    data: { leadId: event.leadId, contactId: event.contactId },
    dedupeKey: key('lead.converted', event.leadId, event.convertedAt),
  };
}

const DEAL_TITLES = {
  WON: { type: NotificationType.DEAL_WON, title: 'One of your deals was won' },
  LOST: { type: NotificationType.DEAL_LOST, title: 'One of your deals was lost' },
  OPEN: { type: NotificationType.DEAL_STAGE_CHANGED, title: 'One of your deals changed stage' },
} as const;

export function dealStageChangedJob(
  event: DealStageChangedEvent,
  ownerId: string,
): CreateNotificationJob | null {
  if (ownerId === event.actorId) return null;
  const { type, title } = DEAL_TITLES[event.status];
  return {
    organizationId: event.organizationId,
    userId: ownerId,
    type,
    title,
    body: null,
    data: { dealId: event.dealId, toStageId: event.toStageId },
    dedupeKey: key('deal.stage_changed', event.dealId, event.changedAt),
  };
}

// What the scheduled task jobs know about a task, the same fields for both alerts.
interface TaskAlertSubject {
  organizationId: string;
  taskId: string;
  assigneeId: string;
}

// The key carries the instant the alert is about (reminderAt / dueDate), so moving that date makes a
// NEW key: the new reminder is a new fact, while a retry of the old one stays a duplicate.
export function taskDueSoonJob(
  task: TaskAlertSubject & { reminderAt: Date },
): CreateNotificationJob {
  return {
    organizationId: task.organizationId,
    userId: task.assigneeId,
    type: NotificationType.TASK_DUE_SOON,
    title: 'A task is coming up',
    body: null,
    data: { taskId: task.taskId },
    dedupeKey: key('task.reminder', task.taskId, task.reminderAt),
  };
}

export function taskOverdueJob(task: TaskAlertSubject & { dueDate: Date }): CreateNotificationJob {
  return {
    organizationId: task.organizationId,
    userId: task.assigneeId,
    type: NotificationType.TASK_OVERDUE,
    title: 'A task is overdue',
    body: null,
    data: { taskId: task.taskId },
    dedupeKey: key('task.overdue', task.taskId, task.dueDate),
  };
}
