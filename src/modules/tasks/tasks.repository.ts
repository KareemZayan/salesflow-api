import { Inject, Injectable } from '@nestjs/common';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import { inLocks } from '../../common/tenant/in-locks.util';
import {
  TenantPrismaClient,
  TenantTransactionClient,
} from '../../common/tenant/tenant-scope.extension';
import { queryPage } from '../../common/utils/pagination.util';
import { nullIfNotFound } from '../../common/utils/prisma-error.util';
import { containsAny } from '../../common/utils/search.util';
import { applyVisibility } from '../../common/visibility/ownership-filter';
import { VisibilityScope } from '../../common/visibility/visibility.types';
import { Prisma, TaskStatus } from '../../generated/prisma/client';
import { LockRequest } from '../../infrastructure/prisma/advisory-lock';
import { PRISMA_TENANT } from '../../infrastructure/prisma/prisma.constants';
import { ListTasksQueryDto } from './dto/list-tasks-query.dto';
import {
  OPEN_TASK_STATUSES,
  TASK_SEARCH_FIELDS,
  TASK_SORT_FIELDS,
  notOverdueWhere,
  overdueWhere,
} from './tasks.constants';

// An explicit select: the response shape is decided here, never by whatever the table gains later.
// `reminderSentAt` is the reminder job's marker and stays internal.
const taskSelect = {
  id: true,
  title: true,
  description: true,
  status: true,
  priority: true,
  dueDate: true,
  completedAt: true,
  reminderAt: true,
  assigneeId: true,
  createdById: true,
  leadId: true,
  dealId: true,
  contactId: true,
  companyId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.TaskSelect;

export type TaskRecord = Prisma.TaskGetPayload<{ select: typeof taskSelect }>;

export type NewTaskData = Pick<
  Prisma.TaskUncheckedCreateInput,
  | 'organizationId'
  | 'assigneeId'
  | 'createdById'
  | 'title'
  | 'description'
  | 'priority'
  | 'dueDate'
  | 'reminderAt'
  | 'leadId'
  | 'dealId'
  | 'contactId'
  | 'companyId'
>;

// Status and completedAt are deliberately absent: only the status endpoint changes them.
export type TaskChanges = Pick<
  Prisma.TaskUncheckedUpdateInput,
  | 'assigneeId'
  | 'title'
  | 'description'
  | 'priority'
  | 'dueDate'
  | 'reminderAt'
  | 'reminderSentAt'
  | 'leadId'
  | 'dealId'
  | 'contactId'
  | 'companyId'
>;

export type TasksTx = TenantTransactionClient;
type TaskDb = Pick<TasksTx, 'task'>;

// The assignee is the owner of a task, so visibility targets this column.
const OWNER_FIELD = 'assigneeId';
const visibility = (scope: VisibilityScope, where?: Prisma.TaskWhereInput) =>
  applyVisibility<Prisma.TaskWhereInput>(where, scope, OWNER_FIELD);

// A closed task is read-only: edits carry this in their where, in the same statement as the write,
// so a task closed a moment earlier makes them match nothing (TASK_CLOSED, decided by a re-read).
const stillOpen = { status: { in: [...OPEN_TASK_STATUSES] } } satisfies Prisma.TaskWhereInput;

// The tenant client adds `organizationId` to every query below (tasks are hard-deleted, so there is
// no `deletedAt`). Visibility is ANDed into the same `where` as the read or write itself, so "may
// the caller touch this row?" and "touch it" are ONE statement.
@Injectable()
export class TasksRepository {
  constructor(@Inject(PRISMA_TENANT) private readonly prisma: TenantPrismaClient) {}

  // Check-then-write across several rows: take the locks (advisory-lock.ts: company, contact, both
  // SHARED for task writes), then run `work` in the same transaction.
  inLocks<T>(locks: readonly LockRequest[], work: (tx: TasksTx) => Promise<T>): Promise<T> {
    return inLocks(this.prisma, locks, work);
  }

  findPage(
    scope: VisibilityScope,
    query: ListTasksQueryDto,
    now: Date,
  ): Promise<PaginatedResponseDto<TaskRecord>> {
    const { dueBefore, dueAfter, overdue } = query;
    return queryPage(query, {
      where: visibility(scope, {
        assigneeId: query.assigneeId,
        status: query.status,
        priority: query.priority,
        leadId: query.leadId,
        dealId: query.dealId,
        contactId: query.contactId,
        companyId: query.companyId,
        ...(dueBefore || dueAfter
          ? {
              dueDate: {
                ...(dueBefore && { lte: new Date(dueBefore) }),
                ...(dueAfter && { gte: new Date(dueAfter) }),
              },
            }
          : {}),
        // In AND so it combines with the plain `status` / `dueDate` filters instead of replacing them.
        ...(overdue !== undefined && { AND: [overdue ? overdueWhere(now) : notOverdueWhere(now)] }),
        ...containsAny<Prisma.TaskWhereInput>(query.q, TASK_SEARCH_FIELDS),
      }),
      sortFields: TASK_SORT_FIELDS,
      fallbackSort: 'createdAt',
      find: (args) => this.prisma.task.findMany({ ...args, select: taskSelect }),
      count: (where) => this.prisma.task.count({ where }),
    });
  }

  findVisible(
    scope: VisibilityScope,
    id: string,
    db: TaskDb = this.prisma,
  ): Promise<TaskRecord | null> {
    return db.task.findFirst({ where: visibility(scope, { id }), select: taskSelect });
  }

  // `db` is the caller's transaction when it holds the company / contact locks for the links.
  create(data: NewTaskData, db: TaskDb = this.prisma): Promise<TaskRecord> {
    return db.task.create({ data, select: taskSelect });
  }

  // `null` = no such editable task for this caller (missing, other tenant, not visible, reassigned
  // away after it was loaded, or CLOSED). The service looks again, with visibility, to answer 404 or
  // TASK_CLOSED.
  updateOpenVisible(
    scope: VisibilityScope,
    id: string,
    data: TaskChanges,
    db: TaskDb = this.prisma,
  ): Promise<TaskRecord | null> {
    return nullIfNotFound(
      db.task.update({
        where: { id, ...stillOpen, ...visibility(scope) },
        data,
        select: taskSelect,
      }),
    );
  }

  // The compare-and-set of a status change: ONE conditional update that matches only while the task
  // is still in the status the caller read (`from`) and still visible to the caller. `completedAt`
  // follows the status: set on COMPLETED, cleared by every other status (so a reopen clears it).
  // `null` = it matched nothing, and then nothing was written.
  transitionStatus(
    scope: VisibilityScope,
    id: string,
    from: TaskStatus,
    to: TaskStatus,
    now: Date,
  ): Promise<TaskRecord | null> {
    return nullIfNotFound(
      this.prisma.task.update({
        where: { id, status: from, ...visibility(scope) },
        data: { status: to, completedAt: to === TaskStatus.COMPLETED ? now : null },
        select: taskSelect,
      }),
    );
  }

  // Hard delete (Task is not soft-deleted). With `openOnly`, a closed task matches nothing, in the
  // same statement. `false` = nothing deleted.
  async deleteVisible(scope: VisibilityScope, id: string, openOnly: boolean): Promise<boolean> {
    const deleted = await nullIfNotFound(
      this.prisma.task.delete({
        where: { id, ...(openOnly && stillOpen), ...visibility(scope) },
        select: { id: true },
      }),
    );
    return deleted !== null;
  }
}
