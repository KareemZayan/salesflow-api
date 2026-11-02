import { TransitionMap } from '../../common/utils/status-transition.util';
import { TaskStatus } from '../../generated/prisma/client';

// What a task may move to through POST /tasks/:id/status. A closed task (COMPLETED / CANCELLED) can
// only be reopened to OPEN; from there the normal moves apply again. Asking for the current status
// is not in any list, so it is rejected like every other impossible move.
export const TASK_STATUS_TRANSITIONS: TransitionMap<TaskStatus> = {
  [TaskStatus.OPEN]: [TaskStatus.IN_PROGRESS, TaskStatus.COMPLETED, TaskStatus.CANCELLED],
  [TaskStatus.IN_PROGRESS]: [TaskStatus.OPEN, TaskStatus.COMPLETED, TaskStatus.CANCELLED],
  [TaskStatus.COMPLETED]: [TaskStatus.OPEN],
  [TaskStatus.CANCELLED]: [TaskStatus.OPEN],
};
