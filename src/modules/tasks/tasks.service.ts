import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ADMIN_ROLE_NAME } from '../../common/constants/roles';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import { publishDomainEvent } from '../../common/events/publish-domain-event';
import { resourceNotFound } from '../../common/exceptions/resource-not-found';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { assertHasChanges } from '../../common/utils/assert-has-changes.util';
import { applyStatusTransition } from '../../common/utils/status-transition.util';
import { instantToDate } from '../../common/validators/is-instant.validator';
import { ownerForCreate, ownerForTransfer } from '../../common/visibility/owner-assignment';
import { OwnershipScopeService } from '../../common/visibility/ownership-scope.service';
import { VisibilityScope } from '../../common/visibility/visibility.types';
import { LockRequest } from '../../infrastructure/prisma/advisory-lock';
import { CompaniesService } from '../companies/companies.service';
import { ContactsService } from '../contacts/contacts.service';
import { DealsService } from '../deals/deals.service';
import { LeadsService } from '../leads/leads.service';
import { ChangeTaskStatusDto } from './dto/change-task-status.dto';
import { CreateTaskDto } from './dto/create-task.dto';
import { ListTasksQueryDto } from './dto/list-tasks-query.dto';
import { TaskResponseDto } from './dto/task-response.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { TASK_ASSIGNED_EVENT, TaskAssignedEvent } from './events/task-assigned.event';
import { assertReminder, instantChanged } from './task-reminder';
import { TASK_STATUS_TRANSITIONS } from './task-status-transitions';
import { isOpenTask } from './tasks.constants';
import {
  TaskClosedException,
  concurrentTaskStatusChange,
  rejectedTaskTransition,
  taskDeleteRestricted,
} from './tasks.exceptions';
import { toTaskResponse } from './tasks.mapper';
import { TaskChanges, TasksRepository, TasksTx } from './tasks.repository';

// Every request reads the clock ONCE (`const now = new Date()`) and uses that value for the
// overdue filter, the `isOverdue` field and the reminder checks, so they cannot disagree.
@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(
    private readonly repository: TasksRepository,
    private readonly ownership: OwnershipScopeService,
    private readonly leads: LeadsService,
    private readonly deals: DealsService,
    private readonly contacts: ContactsService,
    private readonly companies: CompaniesService,
    private readonly events: EventEmitter2,
  ) {}

  async list(
    actor: AuthenticatedUser,
    query: ListTasksQueryDto,
  ): Promise<PaginatedResponseDto<TaskResponseDto>> {
    const now = new Date();
    const page = await this.repository.findPage(await this.ownership.resolve(actor), query, now);
    return { ...page, data: page.data.map((task) => toTaskResponse(task, now)) };
  }

  async get(actor: AuthenticatedUser, id: string): Promise<TaskResponseDto> {
    const now = new Date();
    const task = await this.repository.findVisible(await this.ownership.resolve(actor), id);
    if (!task) throw resourceNotFound('Task');
    return toTaskResponse(task, now);
  }

  async create(actor: AuthenticatedUser, dto: CreateTaskDto): Promise<TaskResponseDto> {
    const now = new Date();
    const scope = await this.ownership.resolve(actor);
    const assigneeId = await ownerForCreate(this.ownership, actor, dto.assigneeId);
    const dueDate = dto.dueDate ? instantToDate(dto.dueDate) : null;
    const reminderAt = dto.reminderAt ? instantToDate(dto.reminderAt) : null;
    assertReminder({ dueDate, reminderAt }, now, true);

    if (dto.leadId) await this.leads.assertLinkable(scope, dto.leadId);
    if (dto.dealId) await this.deals.assertLinkable(scope, dto.dealId);
    const task = await this.writeLinked(scope, dto.companyId, dto.contactId, (db) =>
      this.repository.create(
        {
          organizationId: actor.organizationId,
          assigneeId,
          createdById: actor.userId,
          title: dto.title,
          description: dto.description,
          priority: dto.priority,
          dueDate,
          reminderAt,
          leadId: dto.leadId,
          dealId: dto.dealId,
          contactId: dto.contactId,
          companyId: dto.companyId,
        },
        db,
      ),
    );

    if (assigneeId !== actor.userId) this.publishAssigned(actor, task.id, assigneeId, null, now);
    return toTaskResponse(task, now);
  }

  async update(actor: AuthenticatedUser, id: string, dto: UpdateTaskDto): Promise<TaskResponseDto> {
    assertHasChanges(dto);
    const now = new Date();
    const scope = await this.ownership.resolve(actor);
    const { assigneeId, leadId, dealId, contactId, companyId, dueDate, reminderAt, ...fields } =
      dto;

    const current = await this.repository.findVisible(scope, id);
    if (!current) throw resourceNotFound('Task');
    // Say "closed" before judging the new assignee or links: the task is read-only whoever gets it.
    if (!isOpenTask(current.status)) throw new TaskClosedException();

    const changes: TaskChanges = fields;
    const newAssignee =
      assigneeId === undefined
        ? undefined
        : await ownerForTransfer(this.ownership, scope, assigneeId, current.assigneeId);
    changes.assigneeId = newAssignee;

    // The dates the task WILL have: the request merged over what is stored.
    const nextDue = merge(current.dueDate, dueDate);
    const nextReminder = merge(current.reminderAt, reminderAt);
    const reminderChanged = instantChanged(current.reminderAt, nextReminder);
    assertReminder({ dueDate: nextDue, reminderAt: nextReminder }, now, reminderChanged);
    if (dueDate !== undefined) changes.dueDate = nextDue;
    if (reminderAt !== undefined) changes.reminderAt = nextReminder;
    // A moved reminder re-arms the reminder job and a moved due date re-arms the overdue job (both
    // skip tasks whose marker is set). The markers are cleared by the SAME UPDATE that changes the
    // date, so there is no moment with the new date and the old marker. Reopening a task does NOT
    // clear overdueNotifiedAt: the same dueDate is never notified twice.
    const dueChanged = instantChanged(current.dueDate, nextDue);
    if (dueChanged || reminderChanged) changes.reminderSentAt = null;
    if (dueChanged) changes.overdueNotifiedAt = null;

    // Only a link the task does not already have is checked (and, for contact / company, locked).
    // `null` unlinks and needs neither. An unchanged link stays as is, so a task can still be edited
    // after its contact moved to someone else or was deleted.
    const newLead = leadId && leadId !== current.leadId ? leadId : undefined;
    const newDeal = dealId && dealId !== current.dealId ? dealId : undefined;
    const newCompany = companyId && companyId !== current.companyId ? companyId : undefined;
    const newContact = contactId && contactId !== current.contactId ? contactId : undefined;
    if (leadId !== undefined) changes.leadId = leadId;
    if (dealId !== undefined) changes.dealId = dealId;
    if (companyId !== undefined) changes.companyId = companyId;
    if (contactId !== undefined) changes.contactId = contactId;
    if (newLead) await this.leads.assertLinkable(scope, newLead);
    if (newDeal) await this.deals.assertLinkable(scope, newDeal);

    const updated = await this.writeLinked(scope, newCompany, newContact, (db) =>
      this.repository.updateOpenVisible(scope, id, changes, db),
    );
    if (!updated) throw await this.whyNotEditable(scope, id);

    if (newAssignee) this.publishAssigned(actor, id, newAssignee, current.assigneeId, now);
    return toTaskResponse(updated, now);
  }

  // The shared compare-and-set (common/utils/status-transition.util.ts): the task is read with the
  // caller's visibility, and the write only matches while it is still in the status that was read,
  // so two racing changes cannot both win. Not idempotent: asking for the current status is a 409.
  async changeStatus(
    actor: AuthenticatedUser,
    id: string,
    dto: ChangeTaskStatusDto,
  ): Promise<TaskResponseDto> {
    const now = new Date();
    const scope = await this.ownership.resolve(actor);
    const changed = await applyStatusTransition({
      map: TASK_STATUS_TRANSITIONS,
      to: dto.status,
      read: () => this.repository.findVisible(scope, id),
      write: (from) => this.repository.transitionStatus(scope, id, from, dto.status, now),
      notFound: () => resourceNotFound('Task'),
      rejected: rejectedTaskTransition,
      changedConcurrently: concurrentTaskStatusChange,
    });
    return toTaskResponse(changed, now);
  }

  // Hard delete. A closed (COMPLETED / CANCELLED) task is part of the history of the work, so only an
  // ADMIN may delete it: for everyone else it is excluded in the same statement as the delete, and a
  // miss on a task they can see answers 403 (a task they cannot see is the usual 404).
  // Audit TODO (Phase 13): record this delete in the audit log; until then the structured log keeps
  // who deleted which task (ids only, no content).
  async delete(actor: AuthenticatedUser, id: string): Promise<void> {
    const scope = await this.ownership.resolve(actor);
    const openOnly = actor.role !== ADMIN_ROLE_NAME;
    if (!(await this.repository.deleteVisible(scope, id, openOnly))) {
      const task = openOnly ? await this.repository.findVisible(scope, id) : null;
      throw task && !isOpenTask(task.status) ? taskDeleteRestricted() : resourceNotFound('Task');
    }
    this.logger.log({
      event: 'task.deleted',
      organizationId: actor.organizationId,
      taskId: id,
      actorId: actor.userId,
    });
  }

  // Runs `write` in a transaction holding SHARED company / contact locks (order company -> contact)
  // with the links verified inside it, or plainly when no contact or company link is CHANGING (then
  // there is nothing to lock: the 7b rule). Shared, because two tasks need not wait for each other;
  // a contact / company delete (exclusive) waits for us and counts our task afterwards.
  private writeLinked<T>(
    scope: VisibilityScope,
    companyId: string | undefined,
    contactId: string | undefined,
    write: (db?: TasksTx) => Promise<T>,
  ): Promise<T> {
    const locks: LockRequest[] = [
      ...(companyId ? [{ kind: 'company' as const, id: companyId, mode: 'shared' as const }] : []),
      ...(contactId ? [{ kind: 'contact' as const, id: contactId, mode: 'shared' as const }] : []),
    ];
    if (locks.length === 0) return write();
    return this.repository.inLocks(locks, async (tx) => {
      if (companyId) await this.companies.assertLinkable(tx, scope, companyId);
      if (contactId) await this.contacts.assertLinkable(tx, scope, contactId);
      return write(tx);
    });
  }

  // An update matched nothing. Look again WITH the caller's visibility: a task they can see that is
  // no longer open answers 409; everything else (missing, other tenant, not theirs, reassigned away,
  // deleted) is the one 404, so a hidden closed task is never revealed.
  private async whyNotEditable(scope: VisibilityScope, id: string): Promise<Error> {
    const task = await this.repository.findVisible(scope, id);
    return task && !isOpenTask(task.status) ? new TaskClosedException() : resourceNotFound('Task');
  }

  private publishAssigned(
    actor: AuthenticatedUser,
    taskId: string,
    assigneeId: string,
    previousAssigneeId: string | null,
    assignedAt: Date,
  ): void {
    publishDomainEvent(
      this.events,
      this.logger,
      TASK_ASSIGNED_EVENT,
      {
        organizationId: actor.organizationId,
        taskId,
        assigneeId,
        previousAssigneeId,
        actorId: actor.userId,
        assignedAt,
      } satisfies TaskAssignedEvent,
      `task ${taskId}`,
    );
  }
}

// A PATCH value over the stored one: omitted keeps it, `null` clears it, a string replaces it.
function merge(stored: Date | null, requested: string | null | undefined): Date | null {
  if (requested === undefined) return stored;
  return requested === null ? null : instantToDate(requested);
}
