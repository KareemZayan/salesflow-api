import { HttpException, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { OwnershipScopeService } from '../../common/visibility/ownership-scope.service';
import { VisibilityScope } from '../../common/visibility/visibility.types';
import { TaskPriority, TaskStatus } from '../../generated/prisma/client';
import { LockRequest } from '../../infrastructure/prisma/advisory-lock';
import { AuditService } from '../audit-logs/audit.service';
import { CompaniesService } from '../companies/companies.service';
import { ContactsService } from '../contacts/contacts.service';
import { DealsService } from '../deals/deals.service';
import { LeadsService } from '../leads/leads.service';
import { TASK_ASSIGNED_EVENT } from './events/task-assigned.event';
import { TaskRecord, TasksRepository } from './tasks.repository';
import { TasksService } from './tasks.service';

const tx = { marker: 'tx' };
const repository = {
  inLocks: vi.fn(),
  findPage: vi.fn(),
  findVisible: vi.fn(),
  create: vi.fn(),
  updateOpenVisible: vi.fn(),
  transitionStatus: vi.fn(),
  deleteVisible: vi.fn(),
};
const ownership = { resolve: vi.fn(), resolveAssignableOwner: vi.fn() };
const leads = { assertLinkable: vi.fn() };
const deals = { assertLinkable: vi.fn() };
const contacts = { assertLinkable: vi.fn() };
const companies = { assertLinkable: vi.fn() };
const emitAsync = vi.fn();
const audit = { record: vi.fn() };
const service = new TasksService(
  repository as unknown as TasksRepository,
  ownership as unknown as OwnershipScopeService,
  leads as unknown as LeadsService,
  deals as unknown as DealsService,
  contacts as unknown as ContactsService,
  companies as unknown as CompaniesService,
  { emitAsync } as unknown as EventEmitter2,
  audit as unknown as AuditService,
);

const actor: AuthenticatedUser = {
  userId: 'me',
  organizationId: 'org',
  role: 'SALES_REP',
  permissions: [],
  mustChangePassword: false,
};
const admin: AuthenticatedUser = { ...actor, role: 'ADMIN' };
const scope: VisibilityScope = { kind: 'owners', ownerIds: ['me'] };
const task = (overrides: Partial<TaskRecord> = {}): TaskRecord => ({
  id: 't1',
  title: 'Call back',
  description: null,
  status: TaskStatus.OPEN,
  priority: TaskPriority.MEDIUM,
  dueDate: null,
  completedAt: null,
  reminderAt: null,
  assigneeId: 'me',
  createdById: 'me',
  leadId: null,
  dealId: null,
  contactId: null,
  companyId: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...overrides,
});
const failure = async (promise: Promise<unknown>) => {
  const error = (await promise.catch((e: unknown) => e)) as HttpException;
  const body = error.getResponse() as { code?: string };
  return { status: error.getStatus(), code: body.code };
};
const FUTURE = '2099-01-01T00:00:00Z';
let locks: readonly LockRequest[] = [];

beforeEach(() => {
  vi.resetAllMocks();
  locks = [];
  ownership.resolve.mockResolvedValue(scope);
  repository.inLocks.mockImplementation(
    (requested: readonly LockRequest[], work: (t: unknown) => Promise<unknown>) => {
      locks = requested;
      return work(tx);
    },
  );
  repository.create.mockResolvedValue(task());
  repository.findVisible.mockResolvedValue(task());
  repository.updateOpenVisible.mockResolvedValue(task());
  repository.transitionStatus.mockResolvedValue(task({ status: TaskStatus.COMPLETED }));
  repository.deleteVisible.mockResolvedValue({ assigneeId: 'me' });
  emitAsync.mockResolvedValue([]);
});

describe('TasksService.create', () => {
  it('assigns the task to the caller by default, with no lock, no transaction and no event', async () => {
    await service.create(actor, { title: 'Call back' });
    expect(ownership.resolveAssignableOwner).not.toHaveBeenCalled();
    expect(repository.inLocks).not.toHaveBeenCalled();
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org',
        assigneeId: 'me',
        createdById: 'me',
        dueDate: null,
        reminderAt: null,
      }),
      undefined,
    );
    expect(emitAsync).not.toHaveBeenCalled();
  });

  it('checks another assignee through the assignment rule and publishes task.assigned', async () => {
    ownership.resolveAssignableOwner.mockResolvedValue('colleague');
    await service.create(actor, { title: 'x', assigneeId: 'colleague' });
    expect(ownership.resolveAssignableOwner).toHaveBeenCalledWith(scope, 'colleague');
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ assigneeId: 'colleague', createdById: 'me' }),
      undefined,
    );
    expect(emitAsync).toHaveBeenCalledWith(
      TASK_ASSIGNED_EVENT,
      expect.objectContaining({
        organizationId: 'org',
        taskId: 't1',
        assigneeId: 'colleague',
        previousAssigneeId: null,
        actorId: 'me',
      }),
    );
  });

  it('names the caller as assignee without a check and without an event', async () => {
    await service.create(actor, { title: 'x', assigneeId: 'me' });
    expect(ownership.resolveAssignableOwner).not.toHaveBeenCalled();
    expect(emitAsync).not.toHaveBeenCalled();
  });

  it('writes nothing when the assignee is refused', async () => {
    ownership.resolveAssignableOwner.mockRejectedValue(new HttpException({ code: 'X' }, 400));
    await failure(service.create(actor, { title: 'x', assigneeId: 'stranger' }));
    expect(repository.create).not.toHaveBeenCalled();
    expect(emitAsync).not.toHaveBeenCalled();
  });

  it('stores due date and reminder as UTC instants, whatever offset was sent', async () => {
    await service.create(actor, {
      title: 'x',
      dueDate: '2099-01-01T12:00:00+02:00',
      reminderAt: '2099-01-01T08:00:00-02:00',
    });
    const [data] = repository.create.mock.calls[0] as [{ dueDate: Date; reminderAt: Date }];
    expect(data.dueDate.toISOString()).toBe('2099-01-01T10:00:00.000Z');
    expect(data.reminderAt.toISOString()).toBe('2099-01-01T10:00:00.000Z');
  });

  it('allows a due date in the past', async () => {
    await service.create(actor, { title: 'x', dueDate: '2000-01-01T00:00:00Z' });
    expect(repository.create).toHaveBeenCalled();
  });

  it('refuses a reminder in the past or after the due date, before writing anything', async () => {
    expect(
      await failure(service.create(actor, { title: 'x', reminderAt: '2000-01-01T00:00:00Z' })),
    ).toEqual({ status: 400, code: 'INVALID_REMINDER' });
    expect(
      await failure(
        service.create(actor, {
          title: 'x',
          dueDate: '2099-01-01T00:00:00Z',
          reminderAt: '2099-01-02T00:00:00Z',
        }),
      ),
    ).toEqual({ status: 400, code: 'INVALID_REMINDER' });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('verifies contact and company inside one transaction holding SHARED locks, company first', async () => {
    await service.create(actor, { title: 'x', contactId: 'c1', companyId: 'co1' });
    expect(locks).toEqual([
      { kind: 'company', id: 'co1', mode: 'shared' },
      { kind: 'contact', id: 'c1', mode: 'shared' },
    ]);
    expect(companies.assertLinkable).toHaveBeenCalledWith(tx, scope, 'co1');
    expect(contacts.assertLinkable).toHaveBeenCalledWith(tx, scope, 'c1');
    expect(repository.create).toHaveBeenCalledWith(expect.anything(), tx);
  });

  it('verifies lead and deal without any lock (nothing blocks deleting them)', async () => {
    await service.create(actor, { title: 'x', leadId: 'l1', dealId: 'd1' });
    expect(leads.assertLinkable).toHaveBeenCalledWith(scope, 'l1');
    expect(deals.assertLinkable).toHaveBeenCalledWith(scope, 'd1');
    expect(repository.inLocks).not.toHaveBeenCalled();
  });

  it('writes nothing when a link is refused', async () => {
    contacts.assertLinkable.mockRejectedValue(new HttpException({ code: 'INVALID_CONTACT' }, 400));
    await failure(service.create(actor, { title: 'x', contactId: 'c1' }));
    expect(repository.create).not.toHaveBeenCalled();
  });
});

describe('TasksService.update', () => {
  it('rejects an empty update before touching anything', async () => {
    expect((await failure(service.update(actor, 't1', {}))).code).toBe('EMPTY_UPDATE');
    expect(repository.findVisible).not.toHaveBeenCalled();
  });

  it('answers 404 when the task is not visible', async () => {
    repository.findVisible.mockResolvedValue(null);
    expect(await failure(service.update(actor, 't1', { title: 'x' }))).toEqual({
      status: 404,
      code: 'RESOURCE_NOT_FOUND',
    });
    expect(repository.updateOpenVisible).not.toHaveBeenCalled();
  });

  it.each([TaskStatus.COMPLETED, TaskStatus.CANCELLED])(
    'a %s task is read-only (409 TASK_CLOSED), whatever the request asks',
    async (status) => {
      repository.findVisible.mockResolvedValue(task({ status }));
      expect(await failure(service.update(actor, 't1', { assigneeId: 'other' }))).toEqual({
        status: 409,
        code: 'TASK_CLOSED',
      });
      expect(ownership.resolveAssignableOwner).not.toHaveBeenCalled();
      expect(repository.updateOpenVisible).not.toHaveBeenCalled();
    },
  );

  it('a task closed after it was read answers TASK_CLOSED, one that vanished answers 404', async () => {
    repository.updateOpenVisible.mockResolvedValue(null);
    repository.findVisible
      .mockResolvedValueOnce(task())
      .mockResolvedValueOnce(task({ status: TaskStatus.COMPLETED }));
    expect((await failure(service.update(actor, 't1', { title: 'x' }))).code).toBe('TASK_CLOSED');

    repository.findVisible.mockResolvedValueOnce(task()).mockResolvedValueOnce(null);
    expect((await failure(service.update(actor, 't1', { title: 'x' }))).code).toBe(
      'RESOURCE_NOT_FOUND',
    );
  });

  describe('locks are taken only when a contact or company link CHANGES', () => {
    const linked = task({ contactId: 'c1', companyId: 'co1' });

    it.each([
      ['priority', { priority: TaskPriority.URGENT }],
      ['title', { title: 'New title' }],
      ['due date', { dueDate: FUTURE }],
      ['the same contact and company', { contactId: 'c1', companyId: 'co1' }],
      ['unlinking', { contactId: null, companyId: null }],
      ['linking a lead and a deal', { leadId: 'l1', dealId: 'd1' }],
    ])(
      'editing %s takes no company / contact lock and opens no transaction',
      async (_name, dto) => {
        repository.findVisible.mockResolvedValue(linked);
        ownership.resolveAssignableOwner.mockResolvedValue('other');
        await service.update(actor, 't1', dto);
        expect(repository.inLocks).not.toHaveBeenCalled();
        expect(companies.assertLinkable).not.toHaveBeenCalled();
        expect(contacts.assertLinkable).not.toHaveBeenCalled();
        expect(repository.updateOpenVisible).toHaveBeenCalledWith(
          scope,
          't1',
          expect.anything(),
          undefined,
        );
      },
    );

    it('a reassignment opens a transaction for its audit row but takes no lock', async () => {
      repository.findVisible.mockResolvedValue(linked);
      ownership.resolveAssignableOwner.mockResolvedValue('other');
      await service.update(actor, 't1', { assigneeId: 'other' });
      expect(locks).toEqual([]);
      expect(repository.inLocks).toHaveBeenCalledTimes(1);
      expect(companies.assertLinkable).not.toHaveBeenCalled();
      expect(contacts.assertLinkable).not.toHaveBeenCalled();
      expect(repository.updateOpenVisible).toHaveBeenCalledWith(scope, 't1', expect.anything(), tx);
    });

    it('changing the status takes none either', async () => {
      repository.findVisible.mockResolvedValue(linked);
      await service.changeStatus(actor, 't1', { status: TaskStatus.COMPLETED });
      expect(repository.inLocks).not.toHaveBeenCalled();
      expect(companies.assertLinkable).not.toHaveBeenCalled();
      expect(contacts.assertLinkable).not.toHaveBeenCalled();
    });

    it('a NEW company and contact take SHARED locks, company first, and are verified inside', async () => {
      await service.update(actor, 't1', { contactId: 'c2', companyId: 'co2' });
      expect(locks).toEqual([
        { kind: 'company', id: 'co2', mode: 'shared' },
        { kind: 'contact', id: 'c2', mode: 'shared' },
      ]);
      expect(companies.assertLinkable).toHaveBeenCalledWith(tx, scope, 'co2');
      expect(contacts.assertLinkable).toHaveBeenCalledWith(tx, scope, 'c2');
      expect(repository.updateOpenVisible).toHaveBeenCalledWith(scope, 't1', expect.anything(), tx);
    });

    it('only the link that changes is locked', async () => {
      repository.findVisible.mockResolvedValue(linked);
      await service.update(actor, 't1', { contactId: 'c1', companyId: 'co2' });
      expect(locks).toEqual([{ kind: 'company', id: 'co2', mode: 'shared' }]);
      expect(contacts.assertLinkable).not.toHaveBeenCalled();
    });
  });

  describe('assignment', () => {
    it('reassigning checks the new assignee and publishes task.assigned with the previous one', async () => {
      ownership.resolveAssignableOwner.mockResolvedValue('other');
      await service.update(actor, 't1', { assigneeId: 'other' });
      expect(repository.updateOpenVisible).toHaveBeenCalledWith(
        scope,
        't1',
        expect.objectContaining({ assigneeId: 'other' }),
        tx,
      );
      expect(emitAsync).toHaveBeenCalledWith(
        TASK_ASSIGNED_EVENT,
        expect.objectContaining({ taskId: 't1', assigneeId: 'other', previousAssigneeId: 'me' }),
      );
    });

    it('audits a real reassignment in the same transaction, assigneeId only', async () => {
      ownership.resolveAssignableOwner.mockResolvedValue('other');
      repository.updateOpenVisible.mockResolvedValue(task({ assigneeId: 'other' }));
      await service.update(actor, 't1', { assigneeId: 'other', title: 'Renamed' });
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(tx, {
        event: 'task.reassigned',
        entityId: 't1',
        before: { assigneeId: 'me' },
        after: { assigneeId: 'other' },
      });
    });

    it('audits nothing for the same assignee, an ordinary edit, or a lost race', async () => {
      await service.update(actor, 't1', { assigneeId: 'me', title: 'x' });
      await service.update(actor, 't1', { title: 'Renamed' });
      ownership.resolveAssignableOwner.mockResolvedValue('other');
      repository.updateOpenVisible.mockResolvedValue(null);
      repository.findVisible.mockResolvedValueOnce(task()).mockResolvedValueOnce(null);
      await failure(service.update(actor, 't1', { assigneeId: 'other' }));
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('fails the update when the audit insert fails (the error reaches the transaction)', async () => {
      ownership.resolveAssignableOwner.mockResolvedValue('other');
      audit.record.mockRejectedValue(new Error('audit down'));
      await expect(service.update(actor, 't1', { assigneeId: 'other' })).rejects.toThrow(
        'audit down',
      );
      expect(emitAsync).not.toHaveBeenCalled();
    });

    it('naming the current assignee again changes nothing and publishes nothing', async () => {
      await service.update(actor, 't1', { assigneeId: 'me', title: 'x' });
      expect(ownership.resolveAssignableOwner).not.toHaveBeenCalled();
      expect(emitAsync).not.toHaveBeenCalled();
    });

    it('an ordinary edit publishes nothing', async () => {
      await service.update(actor, 't1', { title: 'Renamed', priority: TaskPriority.HIGH });
      expect(emitAsync).not.toHaveBeenCalled();
    });

    it('publishes nothing when the update lost a race (matched no row)', async () => {
      ownership.resolveAssignableOwner.mockResolvedValue('other');
      repository.updateOpenVisible.mockResolvedValue(null);
      repository.findVisible.mockResolvedValueOnce(task()).mockResolvedValueOnce(null);
      await failure(service.update(actor, 't1', { assigneeId: 'other' }));
      expect(emitAsync).not.toHaveBeenCalled();
    });

    it('a failing event listener never fails the request', async () => {
      ownership.resolveAssignableOwner.mockResolvedValue('other');
      emitAsync.mockRejectedValue(new Error('listener down'));
      const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      await expect(service.update(actor, 't1', { assigneeId: 'other' })).resolves.toBeDefined();
      await Promise.resolve();
      expect(logged).toHaveBeenCalled();
      logged.mockRestore();
    });
  });

  describe('dates and the reminder marker', () => {
    const stored = task({
      dueDate: new Date('2099-06-01T10:00:00.000Z'),
      reminderAt: new Date('2099-06-01T08:00:00.000Z'),
    });

    it('moving the due date re-arms the reminder (reminderSentAt back to null)', async () => {
      repository.findVisible.mockResolvedValue(stored);
      await service.update(actor, 't1', { dueDate: '2099-07-01T10:00:00Z' });
      expect(repository.updateOpenVisible).toHaveBeenCalledWith(
        scope,
        't1',
        expect.objectContaining({ reminderSentAt: null }),
        undefined,
      );
    });

    it('moving the reminder re-arms it too', async () => {
      repository.findVisible.mockResolvedValue(stored);
      await service.update(actor, 't1', { reminderAt: '2099-06-01T09:00:00Z' });
      expect(repository.updateOpenVisible).toHaveBeenCalledWith(
        scope,
        't1',
        expect.objectContaining({ reminderSentAt: null }),
        undefined,
      );
    });

    it('moving the due date also re-arms the overdue notice (overdueNotifiedAt back to null)', async () => {
      repository.findVisible.mockResolvedValue(stored);
      await service.update(actor, 't1', { dueDate: '2099-07-01T10:00:00Z' });
      expect(repository.updateOpenVisible).toHaveBeenCalledWith(
        scope,
        't1',
        expect.objectContaining({ overdueNotifiedAt: null }),
        undefined,
      );
    });

    it('moving only the reminder or editing other fields keeps the overdue marker', async () => {
      repository.findVisible.mockResolvedValue(stored);
      await service.update(actor, 't1', { reminderAt: '2099-06-01T09:00:00Z', title: 'x' });
      const [, , changes] = repository.updateOpenVisible.mock.calls[0] as [
        unknown,
        unknown,
        object,
      ];
      expect(changes).not.toHaveProperty('overdueNotifiedAt');
    });

    it('re-sending the same instants (in another offset) does not touch the marker', async () => {
      repository.findVisible.mockResolvedValue(stored);
      await service.update(actor, 't1', {
        dueDate: '2099-06-01T12:00:00+02:00',
        reminderAt: '2099-06-01T08:00:00Z',
      });
      const [, , changes] = repository.updateOpenVisible.mock.calls[0] as [
        unknown,
        unknown,
        object,
      ];
      expect(changes).not.toHaveProperty('reminderSentAt');
    });

    it('an unrelated edit does not touch the marker', async () => {
      repository.findVisible.mockResolvedValue(stored);
      await service.update(actor, 't1', { title: 'x' });
      const [, , changes] = repository.updateOpenVisible.mock.calls[0] as [
        unknown,
        unknown,
        object,
      ];
      expect(changes).not.toHaveProperty('reminderSentAt');
    });

    it('moving only the due date before the stored reminder is refused', async () => {
      repository.findVisible.mockResolvedValue(stored);
      expect(
        await failure(service.update(actor, 't1', { dueDate: '2099-06-01T07:00:00Z' })),
      ).toEqual({
        status: 400,
        code: 'INVALID_REMINDER',
      });
      expect(repository.updateOpenVisible).not.toHaveBeenCalled();
    });

    it('an edit after the reminder time still works (the stored reminder is not re-judged)', async () => {
      repository.findVisible.mockResolvedValue(
        task({ reminderAt: new Date('2000-01-01T00:00:00.000Z') }),
      );
      await expect(service.update(actor, 't1', { title: 'x' })).resolves.toBeDefined();
    });

    it('clears both with null', async () => {
      repository.findVisible.mockResolvedValue(stored);
      await service.update(actor, 't1', { dueDate: null, reminderAt: null });
      expect(repository.updateOpenVisible).toHaveBeenCalledWith(
        scope,
        't1',
        expect.objectContaining({ dueDate: null, reminderAt: null, reminderSentAt: null }),
        undefined,
      );
    });
  });
});

describe('TasksService.changeStatus', () => {
  it('moves the task with a compare-and-set on the status it read', async () => {
    repository.findVisible.mockResolvedValue(task({ status: TaskStatus.IN_PROGRESS }));
    const result = await service.changeStatus(actor, 't1', { status: TaskStatus.COMPLETED });
    expect(repository.transitionStatus).toHaveBeenCalledWith(
      scope,
      't1',
      TaskStatus.IN_PROGRESS,
      TaskStatus.COMPLETED,
      expect.any(Date),
    );
    expect(result.status).toBe(TaskStatus.COMPLETED);
  });

  it('answers 404 for a task the caller cannot see', async () => {
    repository.findVisible.mockResolvedValue(null);
    expect(
      await failure(service.changeStatus(actor, 't1', { status: TaskStatus.COMPLETED })),
    ).toEqual({
      status: 404,
      code: 'RESOURCE_NOT_FOUND',
    });
  });

  it.each([
    [TaskStatus.OPEN, TaskStatus.OPEN],
    [TaskStatus.COMPLETED, TaskStatus.CANCELLED],
    [TaskStatus.CANCELLED, TaskStatus.COMPLETED],
  ])('%s -> %s is 409 INVALID_TASK_TRANSITION and writes nothing', async (from, to) => {
    repository.findVisible.mockResolvedValue(task({ status: from }));
    expect(await failure(service.changeStatus(actor, 't1', { status: to }))).toEqual({
      status: 409,
      code: 'INVALID_TASK_TRANSITION',
    });
    expect(repository.transitionStatus).not.toHaveBeenCalled();
  });

  it('a lost race is 409 TASK_STATUS_CHANGED; a task that vanished meanwhile is 404', async () => {
    repository.transitionStatus.mockResolvedValue(null);
    repository.findVisible
      .mockResolvedValueOnce(task())
      .mockResolvedValueOnce(task({ status: TaskStatus.CANCELLED }));
    expect(
      await failure(service.changeStatus(actor, 't1', { status: TaskStatus.COMPLETED })),
    ).toEqual({
      status: 409,
      code: 'TASK_STATUS_CHANGED',
    });

    repository.findVisible.mockResolvedValueOnce(task()).mockResolvedValueOnce(null);
    expect(
      (await failure(service.changeStatus(actor, 't1', { status: TaskStatus.COMPLETED }))).status,
    ).toBe(404);
  });
});

describe('TasksService.delete', () => {
  it('a non-admin deletes only OPEN / IN_PROGRESS tasks (the filter is in the delete itself)', async () => {
    await service.delete(actor, 't1');
    expect(repository.deleteVisible).toHaveBeenCalledWith(scope, 't1', true, tx);
  });

  it('an admin may delete a task of any status', async () => {
    await service.delete(admin, 't1');
    expect(repository.deleteVisible).toHaveBeenCalledWith(scope, 't1', false, tx);
  });

  it('audits the delete in the same transaction, with the assignee only (no title or text)', async () => {
    repository.deleteVisible.mockResolvedValue({ assigneeId: 'colleague' });
    await service.delete(actor, 't1');
    expect(audit.record).toHaveBeenCalledWith(tx, {
      event: 'task.deleted',
      entityId: 't1',
      before: { assigneeId: 'colleague' },
    });
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('Call back');
  });

  it('fails the delete when the audit insert fails (the error reaches the transaction)', async () => {
    audit.record.mockRejectedValue(new Error('audit down'));
    await expect(service.delete(actor, 't1')).rejects.toThrow('audit down');
  });

  it('a visible closed task a non-admin tries to delete is 403 TASK_DELETE_RESTRICTED, not audited', async () => {
    repository.deleteVisible.mockResolvedValue(null);
    repository.findVisible.mockResolvedValue(task({ status: TaskStatus.COMPLETED }));
    expect(await failure(service.delete(actor, 't1'))).toEqual({
      status: 403,
      code: 'TASK_DELETE_RESTRICTED',
    });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('a task the caller cannot see is 404 (never 403), closed or not', async () => {
    repository.deleteVisible.mockResolvedValue(null);
    repository.findVisible.mockResolvedValue(null);
    expect(await failure(service.delete(actor, 't1'))).toEqual({
      status: 404,
      code: 'RESOURCE_NOT_FOUND',
    });
  });

  it('an admin deleting a missing task gets 404', async () => {
    repository.deleteVisible.mockResolvedValue(null);
    expect((await failure(service.delete(admin, 't1'))).status).toBe(404);
    expect(repository.findVisible).not.toHaveBeenCalled();
  });
});

describe('TasksService.list / get', () => {
  it('computes isOverdue and the filter from the same clock reading', async () => {
    const past = task({ dueDate: new Date('2000-01-01T00:00:00.000Z') });
    repository.findPage.mockResolvedValue({ data: [past, task()], meta: {} });
    repository.findVisible.mockResolvedValue(past);

    const page = await service.list(actor, {
      page: 1,
      limit: 20,
      sortOrder: 'desc',
      overdue: true,
    });
    const [, , now] = repository.findPage.mock.calls[0] as [unknown, unknown, Date];
    expect(now).toBeInstanceOf(Date);
    expect(page.data.map((t) => t.isOverdue)).toEqual([true, false]);
    expect((await service.get(actor, 't1')).isOverdue).toBe(true);
  });

  it('get answers 404 for a task the caller cannot see', async () => {
    repository.findVisible.mockResolvedValue(null);
    expect((await failure(service.get(actor, 't1'))).status).toBe(404);
  });
});
