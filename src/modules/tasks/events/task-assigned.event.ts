export const TASK_ASSIGNED_EVENT = 'task.assigned';

// Published only when a task is created for someone other than its creator, or when its assignee
// changes (not on every edit). Ids and the tenant only: no title or other task content, so a
// listener (notifications, Phase 12) loads what it needs under its own visibility.
export interface TaskAssignedEvent {
  organizationId: string;
  taskId: string;
  assigneeId: string;
  // Null when the task has just been created.
  previousAssigneeId: string | null;
  actorId: string;
  assignedAt: Date;
}
