import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '../../prisma/seed/prisma-client';
import { ROLE_NAMES } from '../../prisma/seed/permissions';
import {
  createCompany,
  createContact,
  createDeal,
  createLead,
  createTask,
  findDefaultPipeline,
} from '../factories/crm.factory';
import { createTestPrisma, resetDatabase } from '../factories/database';
import {
  createCustomRole,
  createOrganization,
  createUser,
  type TestOrganization,
  type TestUser,
} from '../factories/organization.factory';
import { createTestApp } from '../setup/create-test-app';
import { holdLock, stillPendingAfter } from '../support/advisory-locks';

const API = '/api/v1/tasks';
const MISSING_ID = '11111111-1111-4111-8111-111111111111';
const FUTURE = '2099-01-01T00:00:00Z';
const PAST = '2000-01-01T00:00:00Z';

interface Tokens {
  accessToken: string;
}
interface TaskBody {
  id: string;
  isOverdue: boolean;
  [key: string]: unknown;
}

describe('Tasks (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let orgA: TestOrganization;
  let orgB: TestOrganization;
  let manager: TestUser;
  let report: TestUser;
  let repX: TestUser; // outside the manager's team
  let nobody: TestUser;
  let repB: TestUser;
  let adminT: Tokens;
  let managerT: Tokens;
  let reportT: Tokens;
  let repXT: Tokens;
  let nobodyT: Tokens;
  let repBT: Tokens;
  let pipelineA: Awaited<ReturnType<typeof findDefaultPipeline>>;

  const http = () => request(app.getHttpServer());
  const signIn = async ({ email, password }: Pick<TestUser, 'email' | 'password'>) =>
    (await http().post('/api/v1/auth/login').send({ email, password }).expect(200)).body as Tokens;
  const as = (tokens: Tokens) => ({ Authorization: `Bearer ${tokens.accessToken}` });
  const mine = (org: TestOrganization, user: Pick<TestUser, 'id'>) => ({
    organizationId: org.id,
    assigneeId: user.id,
  });
  const owned = (org: TestOrganization, user: Pick<TestUser, 'id'>) => ({
    organizationId: org.id,
    ownerId: user.id,
  });
  const post = (tokens: Tokens, body: object) => http().post(API).set(as(tokens)).send(body);
  const patch = (tokens: Tokens, id: string, body: object) =>
    http().patch(`${API}/${id}`).set(as(tokens)).send(body);
  const setStatus = (tokens: Tokens, id: string, status: string) =>
    http().post(`${API}/${id}/status`).set(as(tokens)).send({ status });
  const del = (tokens: Tokens, id: string) => http().delete(`${API}/${id}`).set(as(tokens));
  const get = (tokens: Tokens, id: string) => http().get(`${API}/${id}`).set(as(tokens));
  const list = (tokens: Tokens, query = '') => http().get(`${API}${query}`).set(as(tokens));
  const row = (id: string) => prisma.task.findUniqueOrThrow({ where: { id } });
  const ids = (res: request.Response): string[] =>
    (res.body.data as { id: string }[]).map(({ id }) => id).sort();
  const sorted = (...tasks: { id: string }[]) => tasks.map(({ id }) => id).sort();

  beforeAll(async () => {
    app = await createTestApp();
    prisma = createTestPrisma();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    orgA = await createOrganization(prisma, 'orga');
    orgB = await createOrganization(prisma, 'orgb');
    manager = await createUser(prisma, orgA, { role: ROLE_NAMES.SALES_MANAGER });
    report = await createUser(prisma, orgA, { managerId: manager.id });
    repX = await createUser(prisma, orgA);
    const noPermissions = await createCustomRole(prisma, orgA, 'Nobody', []);
    nobody = await createUser(prisma, orgA, { role: noPermissions.name });
    repB = await createUser(prisma, orgB);
    [adminT, managerT, reportT, repXT, nobodyT, repBT] = await Promise.all(
      [orgA.admin, manager, report, repX, nobody, repB].map(signIn),
    );
    pipelineA = await findDefaultPipeline(prisma, orgA.id);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('authentication and permissions', () => {
    it('401 without a token, on every route', async () => {
      const task = await createTask(prisma, mine(orgA, report));
      await http().get(API).expect(401);
      await http().get(`${API}/${task.id}`).expect(401);
      await http().post(API).send({ title: 'x' }).expect(401);
      await http().patch(`${API}/${task.id}`).send({ title: 'x' }).expect(401);
      await http().post(`${API}/${task.id}/status`).send({ status: 'COMPLETED' }).expect(401);
      await http().delete(`${API}/${task.id}`).expect(401);
    });

    it('403 FORBIDDEN without the matching permission, on every route', async () => {
      const task = await createTask(prisma, mine(orgA, nobody));
      for (const res of [
        await list(nobodyT),
        await get(nobodyT, task.id),
        await post(nobodyT, { title: 'x' }),
        await patch(nobodyT, task.id, { title: 'x' }),
        await setStatus(nobodyT, task.id, 'COMPLETED'),
        await del(nobodyT, task.id),
      ]) {
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('FORBIDDEN');
      }
    });
  });

  describe('create', () => {
    it('201: defaults, assignee = caller, exact response shape, nothing internal leaks', async () => {
      const res = await post(reportT, { title: '  Call back ' }).expect(201);
      expect(res.body).toMatchObject({
        title: 'Call back',
        description: null,
        status: 'OPEN',
        priority: 'MEDIUM',
        dueDate: null,
        isOverdue: false,
        completedAt: null,
        reminderAt: null,
        assigneeId: report.id,
        createdById: report.id,
        leadId: null,
        dealId: null,
        contactId: null,
        companyId: null,
      });
      expect(Object.keys(res.body).sort()).toEqual([
        'assigneeId',
        'companyId',
        'completedAt',
        'contactId',
        'createdAt',
        'createdById',
        'dealId',
        'description',
        'dueDate',
        'id',
        'isOverdue',
        'leadId',
        'priority',
        'reminderAt',
        'status',
        'title',
        'updatedAt',
      ]);
      expect((await row(res.body.id)).organizationId).toBe(orgA.id);
    });

    it('stores due date and reminder in UTC whatever offset was sent, and answers in UTC', async () => {
      const res = await post(reportT, {
        title: 'x',
        dueDate: '2099-03-01T12:00:00+02:00',
        reminderAt: '2099-03-01T07:30:00-02:00',
      }).expect(201);
      expect(res.body.dueDate).toBe('2099-03-01T10:00:00.000Z');
      expect(res.body.reminderAt).toBe('2099-03-01T09:30:00.000Z');
      expect((await row(res.body.id)).dueDate?.toISOString()).toBe('2099-03-01T10:00:00.000Z');
    });

    it('a past due date is allowed and the task is overdue at once', async () => {
      const res = await post(reportT, { title: 'x', dueDate: PAST }).expect(201);
      expect(res.body.isOverdue).toBe(true);
    });

    it.each([
      ['a date without a time', { dueDate: '2099-03-01' }],
      ['a date-time without a timezone', { dueDate: '2099-03-01T10:00:00' }],
      ['an impossible calendar day', { dueDate: '2099-02-31T10:00:00Z' }],
      ['a timestamp number', { dueDate: 4_000_000_000_000 }],
      ['a null due date', { dueDate: null }],
      ['a null reminder', { reminderAt: null }],
      ['a null priority', { priority: null }],
      ['an unknown priority', { priority: 'ASAP' }],
      ['a blank title', { title: '   ' }],
      ['a missing title', { title: undefined }],
      ['an over-long title', { title: 'x'.repeat(201) }],
      ['a client status', { status: 'COMPLETED' }],
      ['a client completedAt', { completedAt: FUTURE }],
      ['a client createdById', { createdById: MISSING_ID }],
      ['a client organizationId', { organizationId: MISSING_ID }],
      ['a client reminderSentAt', { reminderSentAt: PAST }],
      ['a non-uuid link', { contactId: 'nope' }],
    ])('400 for %s', async (_name, body) => {
      const res = await post(reportT, { title: 'x', ...body }).expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(await prisma.task.count()).toBe(0);
    });

    it('a blank description is stored as no description', async () => {
      const res = await post(reportT, { title: 'x', description: '   ' }).expect(201);
      expect(res.body.description).toBeNull();
    });

    it('400 INVALID_REMINDER for a reminder in the past or after the due date', async () => {
      for (const body of [
        { reminderAt: PAST },
        { dueDate: '2099-01-01T00:00:00Z', reminderAt: '2099-01-02T00:00:00Z' },
      ]) {
        const res = await post(reportT, { title: 'x', ...body }).expect(400);
        expect(res.body.code).toBe('INVALID_REMINDER');
      }
      expect(await prisma.task.count()).toBe(0);
    });

    it('a reminder exactly at the due date is accepted', async () => {
      await post(reportT, { title: 'x', dueDate: FUTURE, reminderAt: FUTURE }).expect(201);
    });

    describe('assignment', () => {
      it('a rep cannot assign to someone else (INVALID_OWNER), not even a colleague', async () => {
        for (const assigneeId of [repX.id, manager.id, repB.id, MISSING_ID]) {
          const res = await post(reportT, { title: 'x', assigneeId }).expect(400);
          expect(res.body.code).toBe('INVALID_OWNER');
        }
        expect(await prisma.task.count()).toBe(0);
      });

      it('a rep may name themselves', async () => {
        const res = await post(reportT, { title: 'x', assigneeId: report.id }).expect(201);
        expect(res.body.assigneeId).toBe(report.id);
      });

      it('a manager assigns inside the team (and to themselves), not outside it', async () => {
        const inTeam = await post(managerT, { title: 'x', assigneeId: report.id }).expect(201);
        expect(inTeam.body).toMatchObject({ assigneeId: report.id, createdById: manager.id });
        await post(managerT, { title: 'x', assigneeId: manager.id }).expect(201);
        const outside = await post(managerT, { title: 'x', assigneeId: repX.id }).expect(400);
        expect(outside.body.code).toBe('INVALID_OWNER');
      });

      it('an admin assigns to anyone in the organization, never to another organization', async () => {
        await post(adminT, { title: 'x', assigneeId: repX.id }).expect(201);
        const res = await post(adminT, { title: 'x', assigneeId: repB.id }).expect(400);
        expect(res.body.code).toBe('INVALID_OWNER');
      });

      it('an inactive user cannot be assigned', async () => {
        await prisma.user.update({ where: { id: repX.id }, data: { isActive: false } });
        const res = await post(adminT, { title: 'x', assigneeId: repX.id }).expect(400);
        expect(res.body.code).toBe('INVALID_OWNER');
      });
    });

    describe('links', () => {
      it('accepts a lead, a deal, a contact and a company at once', async () => {
        const lead = await createLead(prisma, owned(orgA, report));
        const deal = await createDeal(prisma, owned(orgA, report), {
          pipelineId: pipelineA.id,
          stageId: pipelineA.stages[0]?.id ?? '',
        });
        const contact = await createContact(prisma, owned(orgA, report));
        const company = await createCompany(prisma, owned(orgA, report));
        const res = await post(reportT, {
          title: 'x',
          leadId: lead.id,
          dealId: deal.id,
          contactId: contact.id,
          companyId: company.id,
        }).expect(201);
        expect(res.body).toMatchObject({
          leadId: lead.id,
          dealId: deal.id,
          contactId: contact.id,
          companyId: company.id,
        });
      });

      it.each([
        ['leadId', 'INVALID_LEAD'],
        ['dealId', 'INVALID_DEAL'],
        ['contactId', 'INVALID_CONTACT'],
        ['companyId', 'INVALID_COMPANY'],
      ] as const)(
        '400 %s for a record that is missing, deleted, in another organization or not yours',
        async (field, code) => {
          const make = async (org: TestOrganization, user: TestUser, deleted = false) => {
            const base = owned(org, user);
            const deletedAt = deleted ? new Date() : undefined;
            if (field === 'leadId') return createLead(prisma, base, { deletedAt });
            if (field === 'contactId') return createContact(prisma, base, { deletedAt });
            if (field === 'companyId') return createCompany(prisma, base, { deletedAt });
            const pipeline = await findDefaultPipeline(prisma, org.id);
            return createDeal(
              prisma,
              base,
              { pipelineId: pipeline.id, stageId: pipeline.stages[0]?.id ?? '' },
              { deletedAt },
            );
          };
          const candidates = [
            MISSING_ID,
            (await make(orgB, repB)).id,
            (await make(orgA, report, true)).id,
            (await make(orgA, repX)).id, // exists, but a rep cannot see another rep's record
          ];
          for (const id of candidates) {
            const res = await post(reportT, { title: 'x', [field]: id }).expect(400);
            expect(res.body.code).toBe(code);
          }
          expect(await prisma.task.count()).toBe(0);
        },
      );
    });
  });

  describe('read, visibility and tenant isolation', () => {
    it('each role sees exactly the tasks assigned inside its scope', async () => {
      const mgr = await createTask(prisma, mine(orgA, manager));
      const rep = await createTask(prisma, mine(orgA, report));
      const other = await createTask(prisma, mine(orgA, repX));
      await createTask(prisma, mine(orgB, repB));

      expect(ids(await list(reportT).expect(200))).toEqual(sorted(rep));
      expect(ids(await list(repXT).expect(200))).toEqual(sorted(other));
      expect(ids(await list(managerT).expect(200))).toEqual(sorted(mgr, rep));
      expect(ids(await list(adminT).expect(200))).toEqual(sorted(mgr, rep, other));
    });

    it('GET: a task of someone else, of another organization or a missing one is the same 404', async () => {
      const other = await createTask(prisma, mine(orgA, repX));
      const foreign = await createTask(prisma, mine(orgB, repB));
      for (const id of [other.id, foreign.id, MISSING_ID]) {
        const res = await get(reportT, id).expect(404);
        expect(res.body.code).toBe('RESOURCE_NOT_FOUND');
      }
      await get(managerT, other.id).expect(404);
      await get(adminT, foreign.id).expect(404);
      await get(adminT, other.id).expect(200);
    });

    it("a filter only narrows: asking for someone else's tasks yields an empty page", async () => {
      const other = await createTask(prisma, mine(orgA, repX));
      const res = await list(reportT, `?assigneeId=${repX.id}`).expect(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.meta.total).toBe(0);
      expect(ids(await list(adminT, `?assigneeId=${repX.id}`).expect(200))).toEqual(sorted(other));
    });

    it('tenant isolation: another organization can neither read nor change nor delete a task', async () => {
      const task = await createTask(prisma, mine(orgA, report));
      expect(ids(await list(repBT).expect(200))).toEqual([]);
      await get(repBT, task.id).expect(404);
      await patch(repBT, task.id, { title: 'hijack' }).expect(404);
      await setStatus(repBT, task.id, 'COMPLETED').expect(404);
      await del(repBT, task.id).expect(404);
      expect(await row(task.id)).toMatchObject({ title: task.title, status: 'OPEN' });
    });

    it('lists filter by status, priority, links, text and due window, and sort and paginate', async () => {
      const contact = await createContact(prisma, owned(orgA, report));
      const high = await createTask(prisma, mine(orgA, report), {
        title: '100% sure',
        priority: 'HIGH',
        contactId: contact.id,
        dueDate: new Date('2099-01-10T00:00:00Z'),
      });
      const done = await createTask(prisma, mine(orgA, report), {
        title: 'Done thing',
        status: 'COMPLETED',
        dueDate: new Date('2099-02-10T00:00:00Z'),
      });
      const plain = await createTask(prisma, mine(orgA, report), { title: '100 percent' });

      expect(ids(await list(reportT, '?status=COMPLETED'))).toEqual(sorted(done));
      expect(ids(await list(reportT, '?priority=HIGH'))).toEqual(sorted(high));
      expect(ids(await list(reportT, `?contactId=${contact.id}`))).toEqual(sorted(high));
      expect(ids(await list(reportT, '?q=%25'))).toEqual(sorted(high)); // % is literal
      expect(ids(await list(reportT, '?q=100'))).toEqual(sorted(high, plain));
      expect(
        ids(await list(reportT, '?dueAfter=2099-02-01T00:00:00Z&dueBefore=2099-03-01T00:00:00Z')),
      ).toEqual(sorted(done));
      expect(ids(await list(reportT, '?dueBefore=2099-01-10T00:00:00Z'))).toEqual(sorted(high));

      const page = await list(reportT, '?sortBy=dueDate&sortOrder=asc&limit=2').expect(200);
      expect(page.body.meta).toMatchObject({ limit: 2, total: 3, totalPages: 2 });
      expect((page.body.data as { id: string }[]).map(({ id }) => id)).toEqual([high.id, done.id]);
      expect((await list(reportT, '?sortBy=nope').expect(400)).body.code).toBe(
        'INVALID_SORT_FIELD',
      );
      await list(reportT, '?status=BOGUS').expect(400);
      await list(reportT, '?dueBefore=2099-01-01').expect(400);
      await list(reportT, '?overdue=maybe').expect(400);
    });
  });

  describe('overdue detection', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('a task due exactly now is not overdue; one millisecond later it is', async () => {
      const now = Date.now() + 60_000;
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(now);
      const task = await createTask(prisma, mine(orgA, report), { dueDate: new Date(now) });

      expect((await get(reportT, task.id).expect(200)).body.isOverdue).toBe(false);
      expect(ids(await list(reportT, '?overdue=true'))).toEqual([]);
      expect(ids(await list(reportT, '?overdue=false'))).toEqual(sorted(task));

      vi.setSystemTime(now + 1);
      expect((await get(reportT, task.id).expect(200)).body.isOverdue).toBe(true);
      expect(ids(await list(reportT, '?overdue=true'))).toEqual(sorted(task));
      expect(ids(await list(reportT, '?overdue=false'))).toEqual([]);
    });

    it('the filter and the field agree on every kind of task', async () => {
      const past = new Date('2000-01-01T00:00:00Z');
      const future = new Date('2099-01-01T00:00:00Z');
      const kinds = {
        openPast: await createTask(prisma, mine(orgA, report), { dueDate: past }),
        progressPast: await createTask(prisma, mine(orgA, report), {
          dueDate: past,
          status: 'IN_PROGRESS',
        }),
        completedPast: await createTask(prisma, mine(orgA, report), {
          dueDate: past,
          status: 'COMPLETED',
          completedAt: past,
        }),
        cancelledPast: await createTask(prisma, mine(orgA, report), {
          dueDate: past,
          status: 'CANCELLED',
        }),
        openFuture: await createTask(prisma, mine(orgA, report), { dueDate: future }),
        openNoDue: await createTask(prisma, mine(orgA, report)),
      };

      const all = (await list(reportT, '?limit=100').expect(200)).body.data as TaskBody[];
      const byField = all
        .filter((task) => task.isOverdue)
        .map(({ id }) => id)
        .sort();
      const notByField = all
        .filter((task) => !task.isOverdue)
        .map(({ id }) => id)
        .sort();

      expect(byField).toEqual(sorted(kinds.openPast, kinds.progressPast));
      expect(ids(await list(reportT, '?overdue=true&limit=100'))).toEqual(byField);
      expect(ids(await list(reportT, '?overdue=false&limit=100'))).toEqual(notByField);
      // Together they are the whole list: no task is lost to a NULL due date.
      expect([...byField, ...notByField].sort()).toEqual(ids({ body: { data: all } } as never));
    });

    it('overdue combines with the other filters instead of replacing them', async () => {
      const past = new Date('2000-01-01T00:00:00Z');
      const urgent = await createTask(prisma, mine(orgA, report), {
        dueDate: past,
        priority: 'URGENT',
      });
      await createTask(prisma, mine(orgA, report), { dueDate: past, priority: 'LOW' });
      expect(ids(await list(reportT, '?overdue=true&priority=URGENT'))).toEqual(sorted(urgent));
      expect(ids(await list(reportT, '?overdue=true&status=COMPLETED'))).toEqual([]);
    });

    it('completing an overdue task makes it not overdue; reopening makes it overdue again', async () => {
      const task = await createTask(prisma, mine(orgA, report), {
        dueDate: new Date('2000-01-01T00:00:00Z'),
      });
      expect((await setStatus(reportT, task.id, 'COMPLETED').expect(200)).body.isOverdue).toBe(
        false,
      );
      expect((await setStatus(reportT, task.id, 'OPEN').expect(200)).body.isOverdue).toBe(true);
    });
  });

  describe('update', () => {
    it('200: edits fields, clears with null, and never touches status or the creator', async () => {
      const task = await createTask(prisma, mine(orgA, report), { title: 'Old' });
      const res = await patch(reportT, task.id, {
        title: ' New ',
        description: 'Details',
        priority: 'URGENT',
        dueDate: FUTURE,
      }).expect(200);
      expect(res.body).toMatchObject({
        title: 'New',
        description: 'Details',
        priority: 'URGENT',
        dueDate: '2099-01-01T00:00:00.000Z',
        status: 'OPEN',
        createdById: report.id,
      });
      const cleared = await patch(reportT, task.id, { description: null, dueDate: null }).expect(
        200,
      );
      expect(cleared.body).toMatchObject({ description: null, dueDate: null });
    });

    it.each([
      ['an empty body', {}, 'EMPTY_UPDATE'],
      ['a null title', { title: null }, 'VALIDATION_FAILED'],
      ['a null priority', { priority: null }, 'VALIDATION_FAILED'],
      ['a null assignee', { assigneeId: null }, 'VALIDATION_FAILED'],
      ['a status', { status: 'COMPLETED' }, 'VALIDATION_FAILED'],
      ['a completedAt', { completedAt: FUTURE }, 'VALIDATION_FAILED'],
      ['a createdById', { createdById: MISSING_ID }, 'VALIDATION_FAILED'],
      ['a date without a timezone', { dueDate: '2099-01-01T00:00:00' }, 'VALIDATION_FAILED'],
    ])('400 for %s', async (_name, body, code) => {
      const task = await createTask(prisma, mine(orgA, report));
      const res = await patch(reportT, task.id, body).expect(400);
      expect(res.body.code).toBe(code);
      expect(await row(task.id)).toMatchObject({ title: task.title, status: 'OPEN' });
    });

    it("404 for a task that is missing, another rep's or another organization's", async () => {
      const other = await createTask(prisma, mine(orgA, repX));
      await patch(reportT, MISSING_ID, { title: 'x' }).expect(404);
      await patch(reportT, other.id, { title: 'x' }).expect(404);
      expect((await row(other.id)).title).toBe(other.title);
    });

    it.each(['COMPLETED', 'CANCELLED'] as const)(
      '409 TASK_CLOSED for a %s task, whatever the edit; reopening it unlocks the edits',
      async (status) => {
        const task = await createTask(prisma, mine(orgA, report), { status });
        for (const body of [{ title: 'x' }, { assigneeId: report.id }, { dueDate: FUTURE }]) {
          const res = await patch(reportT, task.id, body).expect(409);
          expect(res.body.code).toBe('TASK_CLOSED');
        }
        await setStatus(reportT, task.id, 'OPEN').expect(200);
        await patch(reportT, task.id, { title: 'Edited after reopening' }).expect(200);
      },
    );

    it('a closed task that the caller cannot see is 404, never 409', async () => {
      const task = await createTask(prisma, mine(orgA, repX), { status: 'COMPLETED' });
      await patch(reportT, task.id, { title: 'x' }).expect(404);
    });

    describe('reassignment', () => {
      it('a rep cannot reassign (INVALID_OWNER); naming the current assignee is a no-op', async () => {
        const task = await createTask(prisma, mine(orgA, report));
        const res = await patch(reportT, task.id, { assigneeId: repX.id }).expect(400);
        expect(res.body.code).toBe('INVALID_OWNER');
        await patch(reportT, task.id, { assigneeId: report.id }).expect(200);
        expect((await row(task.id)).assigneeId).toBe(report.id);
      });

      it('a manager reassigns inside the team and keeps seeing the task; outside is refused', async () => {
        const task = await createTask(prisma, mine(orgA, manager));
        await patch(managerT, task.id, { assigneeId: report.id }).expect(200);
        await get(managerT, task.id).expect(200);
        const res = await patch(managerT, task.id, { assigneeId: repX.id }).expect(400);
        expect(res.body.code).toBe('INVALID_OWNER');
      });

      it('visibility follows the assignee: a rep whose task is reassigned away can no longer see it', async () => {
        const task = await createTask(prisma, mine(orgA, report), { createdById: report.id });
        await get(reportT, task.id).expect(200);
        await patch(adminT, task.id, { assigneeId: repX.id }).expect(200);
        await get(reportT, task.id).expect(404);
        await patch(reportT, task.id, { title: 'x' }).expect(404);
        await get(repXT, task.id).expect(200);
        // The creator is still recorded.
        expect((await row(task.id)).createdById).toBe(report.id);
      });
    });

    describe('links', () => {
      it('links, re-links and unlinks each of the four records', async () => {
        const lead = await createLead(prisma, owned(orgA, report));
        const contact = await createContact(prisma, owned(orgA, report));
        const company = await createCompany(prisma, owned(orgA, report));
        const deal = await createDeal(prisma, owned(orgA, report), {
          pipelineId: pipelineA.id,
          stageId: pipelineA.stages[0]?.id ?? '',
        });
        const task = await createTask(prisma, mine(orgA, report));
        const linked = await patch(reportT, task.id, {
          leadId: lead.id,
          dealId: deal.id,
          contactId: contact.id,
          companyId: company.id,
        }).expect(200);
        expect(linked.body).toMatchObject({
          leadId: lead.id,
          dealId: deal.id,
          contactId: contact.id,
          companyId: company.id,
        });
        const unlinked = await patch(reportT, task.id, {
          leadId: null,
          dealId: null,
          contactId: null,
          companyId: null,
        }).expect(200);
        expect(unlinked.body).toMatchObject({
          leadId: null,
          dealId: null,
          contactId: null,
          companyId: null,
        });
      });

      it('400 for a link the caller may not use, and the task is unchanged', async () => {
        const task = await createTask(prisma, mine(orgA, report));
        const theirs = await createContact(prisma, owned(orgB, repB));
        const hidden = await createCompany(prisma, owned(orgA, repX));
        const gone = await createLead(prisma, owned(orgA, report), { deletedAt: new Date() });
        for (const [body, code] of [
          [{ contactId: theirs.id }, 'INVALID_CONTACT'],
          [{ companyId: hidden.id }, 'INVALID_COMPANY'],
          [{ leadId: gone.id }, 'INVALID_LEAD'],
          [{ dealId: MISSING_ID }, 'INVALID_DEAL'],
        ] as const) {
          expect((await patch(reportT, task.id, body).expect(400)).body.code).toBe(code);
        }
        expect(await row(task.id)).toMatchObject({
          contactId: null,
          companyId: null,
          leadId: null,
          dealId: null,
        });
      });

      it('an unchanged link is not re-judged: a task stays editable after its contact moved away', async () => {
        const contact = await createContact(prisma, owned(orgA, report));
        const task = await createTask(prisma, mine(orgA, report), { contactId: contact.id });
        await prisma.contact.update({ where: { id: contact.id }, data: { ownerId: repX.id } });
        await patch(reportT, task.id, { contactId: contact.id, title: 'Still editable' }).expect(
          200,
        );
        await patch(reportT, task.id, { title: 'Again' }).expect(200);
      });
    });

    describe('dates and the reminder marker', () => {
      const sentAt = new Date('2099-01-01T00:00:00Z');
      const armed = () =>
        createTask(prisma, mine(orgA, report), {
          dueDate: new Date('2099-06-01T10:00:00Z'),
          reminderAt: new Date('2099-06-01T08:00:00Z'),
          reminderSentAt: sentAt,
        });

      it('changing the due date resets reminderSentAt', async () => {
        const task = await armed();
        await patch(reportT, task.id, { dueDate: '2099-07-01T10:00:00Z' }).expect(200);
        expect((await row(task.id)).reminderSentAt).toBeNull();
      });

      it('changing the reminder resets reminderSentAt', async () => {
        const task = await armed();
        await patch(reportT, task.id, { reminderAt: '2099-06-01T09:00:00Z' }).expect(200);
        expect((await row(task.id)).reminderSentAt).toBeNull();
      });

      it('clearing the reminder resets it too', async () => {
        const task = await armed();
        await patch(reportT, task.id, { reminderAt: null }).expect(200);
        expect(await row(task.id)).toMatchObject({ reminderAt: null, reminderSentAt: null });
      });

      it('re-sending the same instants, or editing something else, keeps reminderSentAt', async () => {
        const task = await armed();
        await patch(reportT, task.id, {
          dueDate: '2099-06-01T12:00:00+02:00',
          reminderAt: '2099-06-01T08:00:00Z',
        }).expect(200);
        await patch(reportT, task.id, { title: 'Renamed', priority: 'HIGH' }).expect(200);
        expect((await row(task.id)).reminderSentAt?.toISOString()).toBe(sentAt.toISOString());
      });

      it('400 INVALID_REMINDER when the due date moves before the stored reminder, or the reminder is in the past', async () => {
        const task = await armed();
        for (const body of [{ dueDate: '2099-06-01T07:00:00Z' }, { reminderAt: PAST }]) {
          expect((await patch(reportT, task.id, body).expect(400)).body.code).toBe(
            'INVALID_REMINDER',
          );
        }
        expect((await row(task.id)).reminderSentAt?.toISOString()).toBe(sentAt.toISOString());
      });

      it('a task whose stored reminder time has passed can still be edited', async () => {
        const task = await createTask(prisma, mine(orgA, report), { reminderAt: new Date(PAST) });
        await patch(reportT, task.id, { title: 'Late edit' }).expect(200);
      });
    });
  });

  describe('status', () => {
    it('walks the workflow, setting completedAt on COMPLETED and clearing it on reopen', async () => {
      const task = await createTask(prisma, mine(orgA, report));
      expect((await setStatus(reportT, task.id, 'IN_PROGRESS').expect(200)).body.status).toBe(
        'IN_PROGRESS',
      );
      const done = await setStatus(reportT, task.id, 'COMPLETED').expect(200);
      expect(done.body.status).toBe('COMPLETED');
      expect(done.body.completedAt).not.toBeNull();
      expect((await row(task.id)).completedAt).not.toBeNull();

      const reopened = await setStatus(reportT, task.id, 'OPEN').expect(200);
      expect(reopened.body).toMatchObject({ status: 'OPEN', completedAt: null });
      expect((await row(task.id)).completedAt).toBeNull();

      await setStatus(reportT, task.id, 'CANCELLED').expect(200);
      const again = await setStatus(reportT, task.id, 'OPEN').expect(200);
      expect(again.body.completedAt).toBeNull();
    });

    it.each([
      ['OPEN', 'OPEN'],
      ['IN_PROGRESS', 'IN_PROGRESS'],
      ['COMPLETED', 'COMPLETED'],
      ['COMPLETED', 'CANCELLED'],
      ['CANCELLED', 'COMPLETED'],
      ['COMPLETED', 'IN_PROGRESS'],
    ] as const)('%s -> %s is 409 INVALID_TASK_TRANSITION and changes nothing', async (from, to) => {
      const task = await createTask(prisma, mine(orgA, report), { status: from });
      const res = await setStatus(reportT, task.id, to).expect(409);
      expect(res.body.code).toBe('INVALID_TASK_TRANSITION');
      expect((await row(task.id)).status).toBe(from);
    });

    it('400 for an unknown or missing status; unknown body fields are refused', async () => {
      const task = await createTask(prisma, mine(orgA, report));
      await setStatus(reportT, task.id, 'DONE').expect(400);
      await http().post(`${API}/${task.id}/status`).set(as(reportT)).send({}).expect(400);
      await http()
        .post(`${API}/${task.id}/status`)
        .set(as(reportT))
        .send({ status: 'COMPLETED', from: 'OPEN' })
        .expect(400);
    });

    it("404 for a task that is missing, someone else's or another organization's", async () => {
      const other = await createTask(prisma, mine(orgA, repX));
      await setStatus(reportT, MISSING_ID, 'COMPLETED').expect(404);
      await setStatus(reportT, other.id, 'COMPLETED').expect(404);
      expect((await row(other.id)).status).toBe('OPEN');
    });

    it('two racing completions: exactly one wins, the other is a 409, completedAt is set once', async () => {
      const task = await createTask(prisma, mine(orgA, report));
      const [a, b] = await Promise.all([
        setStatus(reportT, task.id, 'COMPLETED'),
        setStatus(reportT, task.id, 'COMPLETED'),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const loser = a.status === 409 ? a : b;
      expect(['INVALID_TASK_TRANSITION', 'TASK_STATUS_CHANGED']).toContain(loser.body.code);
      expect((await row(task.id)).completedAt).not.toBeNull();
    });

    it("a manager completes a team member's task", async () => {
      const task = await createTask(prisma, mine(orgA, report));
      await setStatus(managerT, task.id, 'COMPLETED').expect(200);
    });
  });

  describe('delete', () => {
    it('a rep deletes their own open task (hard delete, 204); the second call is 404', async () => {
      const task = await createTask(prisma, mine(orgA, report));
      await del(reportT, task.id).expect(204);
      expect(await prisma.task.count({ where: { id: task.id } })).toBe(0);
      await del(reportT, task.id).expect(404);
    });

    it('a rep deleting a task assigned to someone else gets 404 and the task stays', async () => {
      const open = await createTask(prisma, mine(orgA, repX));
      const closed = await createTask(prisma, mine(orgA, repX), { status: 'COMPLETED' });
      for (const task of [open, closed]) {
        expect((await del(reportT, task.id).expect(404)).body.code).toBe('RESOURCE_NOT_FOUND');
        expect(await prisma.task.count({ where: { id: task.id } })).toBe(1);
      }
    });

    it.each(['COMPLETED', 'CANCELLED'] as const)(
      'a rep cannot delete their own %s task (403 TASK_DELETE_RESTRICTED); an admin can',
      async (status) => {
        const task = await createTask(prisma, mine(orgA, report), { status });
        const res = await del(reportT, task.id).expect(403);
        expect(res.body.code).toBe('TASK_DELETE_RESTRICTED');
        expect(await prisma.task.count({ where: { id: task.id } })).toBe(1);
        await del(adminT, task.id).expect(204);
        expect(await prisma.task.count({ where: { id: task.id } })).toBe(0);
      },
    );

    it('a manager is not an admin: a closed team task stays, an open one goes', async () => {
      const closed = await createTask(prisma, mine(orgA, report), { status: 'COMPLETED' });
      const open = await createTask(prisma, mine(orgA, report));
      expect((await del(managerT, closed.id).expect(403)).body.code).toBe('TASK_DELETE_RESTRICTED');
      await del(managerT, open.id).expect(204);
    });

    it('a closed task of another organization is a plain 404 even for an admin', async () => {
      const foreign = await createTask(prisma, mine(orgB, repB), { status: 'COMPLETED' });
      await del(adminT, foreign.id).expect(404);
      expect(await prisma.task.count({ where: { id: foreign.id } })).toBe(1);
    });

    it('a task reopened after completion can be deleted by its assignee again', async () => {
      const task = await createTask(prisma, mine(orgA, report), { status: 'COMPLETED' });
      await setStatus(reportT, task.id, 'OPEN').expect(200);
      await del(reportT, task.id).expect(204);
    });
  });

  describe('tasks whose linked records were deleted still read fine', () => {
    it('GET, list, edit, status and reopen all work; the response carries only ids', async () => {
      const lead = await createLead(prisma, owned(orgA, report));
      const deal = await createDeal(prisma, owned(orgA, report), {
        pipelineId: pipelineA.id,
        stageId: pipelineA.stages[0]?.id ?? '',
      });
      const contact = await createContact(prisma, owned(orgA, report));
      const company = await createCompany(prisma, owned(orgA, report));
      const task = await createTask(prisma, mine(orgA, report), {
        leadId: lead.id,
        dealId: deal.id,
        contactId: contact.id,
        companyId: company.id,
      });
      const deletedAt = new Date();
      await prisma.lead.update({ where: { id: lead.id }, data: { deletedAt } });
      await prisma.deal.update({ where: { id: deal.id }, data: { deletedAt } });
      await prisma.contact.update({ where: { id: contact.id }, data: { deletedAt } });
      await prisma.company.update({ where: { id: company.id }, data: { deletedAt } });

      const read = await get(reportT, task.id).expect(200);
      expect(read.body).toMatchObject({
        leadId: lead.id,
        dealId: deal.id,
        contactId: contact.id,
        companyId: company.id,
      });
      expect(ids(await list(reportT).expect(200))).toEqual(sorted(task));
      expect(ids(await list(reportT, `?contactId=${contact.id}`).expect(200))).toEqual(
        sorted(task),
      );
      await patch(reportT, task.id, { title: 'Still editable', priority: 'LOW' }).expect(200);
      await setStatus(reportT, task.id, 'COMPLETED').expect(200);
      // Reopening with a deleted contact is allowed (decided in ADR 0010).
      await setStatus(reportT, task.id, 'OPEN').expect(200);
    });

    it('open tasks do not block deleting a lead or a deal', async () => {
      const lead = await createLead(prisma, owned(orgA, report));
      const deal = await createDeal(prisma, owned(orgA, report), {
        pipelineId: pipelineA.id,
        stageId: pipelineA.stages[0]?.id ?? '',
      });
      const task = await createTask(prisma, mine(orgA, report), {
        leadId: lead.id,
        dealId: deal.id,
      });
      await http().delete(`/api/v1/leads/${lead.id}`).set(as(reportT)).expect(204);
      await http().delete(`/api/v1/deals/${deal.id}`).set(as(reportT)).expect(204);
      const read = await get(reportT, task.id).expect(200);
      expect(read.body).toMatchObject({ leadId: lead.id, dealId: deal.id });
    });
  });

  describe('locks: taken only when a contact or company link CHANGES', () => {
    it("creating a task for a contact waits for that contact's lock; for a company, that company's", async () => {
      for (const kind of ['contact', 'company'] as const) {
        const record =
          kind === 'contact'
            ? await createContact(prisma, owned(orgA, report))
            : await createCompany(prisma, owned(orgA, report));
        const lock = await holdLock(prisma, kind, record.id);
        const request = post(reportT, { title: 'x', [`${kind}Id`]: record.id }).then((r) => r);
        expect(await stillPendingAfter(request)).toBe(true);
        lock.release();
        expect((await request).status).toBe(201);
        await lock.done;
      }
    });

    it('two task writes for the same contact do not wait for each other (shared mode)', async () => {
      const contact = await createContact(prisma, owned(orgA, report));
      const lock = await holdLock(prisma, 'contact', contact.id, 'shared');
      const res = await post(reportT, { title: 'x', contactId: contact.id });
      expect(res.status).toBe(201);
      lock.release();
      await lock.done;
    });

    it('creating a task with a lead or a deal link waits for no lock', async () => {
      const lead = await createLead(prisma, owned(orgA, report));
      const lock = await holdLock(prisma, 'lead', lead.id);
      const res = await post(reportT, { title: 'x', leadId: lead.id });
      expect(res.status).toBe(201);
      lock.release();
      await lock.done;
    });

    it('priority, title, due date, assignee and status changes ignore held company and contact locks', async () => {
      const contact = await createContact(prisma, owned(orgA, manager));
      const company = await createCompany(prisma, owned(orgA, manager));
      const task = await createTask(prisma, mine(orgA, manager), {
        contactId: contact.id,
        companyId: company.id,
      });
      const contactLock = await holdLock(prisma, 'contact', contact.id);
      const companyLock = await holdLock(prisma, 'company', company.id);

      const results = await Promise.race([
        (async () => [
          (await patch(managerT, task.id, { priority: 'URGENT' })).status,
          (await patch(managerT, task.id, { title: 'Retitled' })).status,
          (await patch(managerT, task.id, { dueDate: FUTURE })).status,
          (await patch(managerT, task.id, { assigneeId: report.id })).status,
          (await patch(managerT, task.id, { contactId: contact.id, companyId: company.id })).status,
          (await patch(managerT, task.id, { contactId: null, companyId: null })).status,
          (await setStatus(managerT, task.id, 'IN_PROGRESS')).status,
          (await setStatus(managerT, task.id, 'COMPLETED')).status,
          (await setStatus(managerT, task.id, 'OPEN')).status,
        ])(),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 8_000)),
      ]);
      contactLock.release();
      companyLock.release();
      await Promise.all([contactLock.done, companyLock.done]);

      expect(results).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200]);
    });

    it('linking a NEW contact or company waits for its lock', async () => {
      const task = await createTask(prisma, mine(orgA, report));
      for (const kind of ['contact', 'company'] as const) {
        const record =
          kind === 'contact'
            ? await createContact(prisma, owned(orgA, report))
            : await createCompany(prisma, owned(orgA, report));
        const lock = await holdLock(prisma, kind, record.id);
        const request = patch(reportT, task.id, { [`${kind}Id`]: record.id }).then((r) => r);
        expect(await stillPendingAfter(request)).toBe(true);
        lock.release();
        expect((await request).status).toBe(200);
        await lock.done;
      }
    });

    it('unlinking waits for no lock', async () => {
      const contact = await createContact(prisma, owned(orgA, report));
      const task = await createTask(prisma, mine(orgA, report), { contactId: contact.id });
      const lock = await holdLock(prisma, 'contact', contact.id);
      const res = await patch(reportT, task.id, { contactId: null });
      expect(res.status).toBe(200);
      lock.release();
      await lock.done;
    });
  });
});
