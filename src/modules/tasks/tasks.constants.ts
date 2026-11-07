import { Prisma, TaskStatus } from '../../generated/prisma/client';

export const TASK_SORT_FIELDS = ['createdAt', 'updatedAt', 'dueDate', 'priority', 'title'] as const;
// Free-text columns the `q` search looks at.
export const TASK_SEARCH_FIELDS = ['title'] as const;

export const TASK_TITLE_MAX_LENGTH = 200;
export const TASK_DESCRIPTION_MAX_LENGTH = 5000;

// Most tasks ONE per-organization alert job handles. A big organization's backlog is worked off over
// several sweeps instead of one job holding a worker: 1,200 due tasks take three sweeps.
export const TASK_ALERT_BATCH_LIMIT = 500;

// Statuses of a task that still needs doing. Everything else (COMPLETED, CANCELLED) is closed:
// read-only, never overdue, and it does not pin the contact or company it points at.
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = [TaskStatus.OPEN, TaskStatus.IN_PROGRESS];

export const isOpenTask = (status: TaskStatus): boolean => OPEN_TASK_STATUSES.includes(status);

// "Overdue" is computed, never stored, and has exactly ONE definition: still open, and the due
// instant is strictly before `now` (a task due exactly now is not overdue yet). The `?overdue`
// filter and the `isOverdue` response field are both built from these two, with the same `now`.
export const overdueWhere = (now: Date): Prisma.TaskWhereInput => ({
  status: { in: [...OPEN_TASK_STATUSES] },
  dueDate: { lt: now },
});

// The exact complement, written out so rows without a due date are included (a plain NOT would drop
// them: SQL's NOT of an unknown is unknown).
export const notOverdueWhere = (now: Date): Prisma.TaskWhereInput => ({
  OR: [
    { status: { notIn: [...OPEN_TASK_STATUSES] } },
    { dueDate: null },
    { dueDate: { gte: now } },
  ],
});

export const isOverdue = (task: { status: TaskStatus; dueDate: Date | null }, now: Date): boolean =>
  isOpenTask(task.status) && task.dueDate !== null && task.dueDate.getTime() < now.getTime();
