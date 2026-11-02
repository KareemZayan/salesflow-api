import { DealStageChangedEvent } from '../deals/events/deal-stage-changed.event';
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
