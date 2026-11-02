import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '../../prisma/seed/prisma-client';
import { ROLE_NAMES } from '../../prisma/seed/permissions';
import {
  createCompany,
  createContact,
  createDeal,
  createTask,
  findDefaultPipeline,
} from '../factories/crm.factory';
import { createTestPrisma, resetDatabase } from '../factories/database';
import {
  createOrganization,
  createUser,
  type TestOrganization,
  type TestUser,
} from '../factories/organization.factory';
import { createTestApp } from '../setup/create-test-app';
import { holdLock, stillPendingAfter } from '../support/advisory-locks';

const TASKS = '/api/v1/tasks';
const RACE_ITERATIONS = 20;

interface Tokens {
  accessToken: string;
}

// Open tasks block deleting their contact or company (409, no counts); the race tests prove that
// linking a task and deleting the record can never both succeed.
describe('Task blockers on contact and company delete (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let orgA: TestOrganization;
  let orgB: TestOrganization;
  let manager: TestUser;
  let report: TestUser;
  let repX: TestUser;
  let repB: TestUser;
  let adminT: Tokens;
  let reportT: Tokens;
  let repXT: Tokens;
  let repBT: Tokens;

  const http = () => request(app.getHttpServer());
  const signIn = async ({ email, password }: Pick<TestUser, 'email' | 'password'>) =>
    (await http().post('/api/v1/auth/login').send({ email, password }).expect(200)).body as Tokens;
  const as = (tokens: Tokens) => ({ Authorization: `Bearer ${tokens.accessToken}` });
  const owned = (org: TestOrganization, user: Pick<TestUser, 'id'>) => ({
    organizationId: org.id,
    ownerId: user.id,
  });
  const mine = (org: TestOrganization, user: Pick<TestUser, 'id'>) => ({
    organizationId: org.id,
    assigneeId: user.id,
  });
  const delContact = (tokens: Tokens, id: string) =>
    http().delete(`/api/v1/contacts/${id}`).set(as(tokens));
  const delCompany = (tokens: Tokens, id: string) =>
    http().delete(`/api/v1/companies/${id}`).set(as(tokens));
  const postTask = (tokens: Tokens, body: object) => http().post(TASKS).set(as(tokens)).send(body);
  const patchTask = (tokens: Tokens, id: string, body: object) =>
    http().patch(`${TASKS}/${id}`).set(as(tokens)).send(body);
  const taskStatus = (tokens: Tokens, id: string, status: string) =>
    http().post(`${TASKS}/${id}/status`).set(as(tokens)).send({ status });

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
    repB = await createUser(prisma, orgB);
    [adminT, reportT, repXT, repBT] = await Promise.all(
      [orgA.admin, report, repX, repB].map(signIn),
    );
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('contact delete', () => {
    it.each(['OPEN', 'IN_PROGRESS'] as const)(
      'a %s task blocks it: 409 CONTACT_HAS_OPEN_TASKS, no count in the message, contact still there',
      async (status) => {
        const contact = await createContact(prisma, owned(orgA, report));
        await createTask(prisma, mine(orgA, report), { contactId: contact.id, status });
        const res = await delContact(reportT, contact.id).expect(409);
        expect(res.body.code).toBe('CONTACT_HAS_OPEN_TASKS');
        expect(res.body.message).toBe('Contact has open tasks and cannot be deleted');
        expect(JSON.stringify(res.body)).not.toMatch(/\d+ task/);
        expect(
          (await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } })).deletedAt,
        ).toBeNull();
      },
    );

    it.each(['COMPLETED', 'CANCELLED'] as const)(
      'a %s task does not block it, and stays readable afterwards',
      async (status) => {
        const contact = await createContact(prisma, owned(orgA, report));
        const task = await createTask(prisma, mine(orgA, report), {
          contactId: contact.id,
          status,
        });
        await delContact(reportT, contact.id).expect(204);
        const read = await http().get(`${TASKS}/${task.id}`).set(as(reportT)).expect(200);
        expect(read.body.contactId).toBe(contact.id);
      },
    );

    it('completing, cancelling or deleting the last open task unblocks it', async () => {
      const contact = await createContact(prisma, owned(orgA, report));
      const task = await createTask(prisma, mine(orgA, report), { contactId: contact.id });
      await delContact(reportT, contact.id).expect(409);
      await taskStatus(reportT, task.id, 'COMPLETED').expect(200);
      await delContact(reportT, contact.id).expect(204);

      const other = await createContact(prisma, owned(orgA, report));
      const second = await createTask(prisma, mine(orgA, report), { contactId: other.id });
      await http().delete(`${TASKS}/${second.id}`).set(as(reportT)).expect(204);
      await delContact(reportT, other.id).expect(204);
    });

    it('unlinking the task or moving it to another contact unblocks it', async () => {
      const contact = await createContact(prisma, owned(orgA, report));
      const task = await createTask(prisma, mine(orgA, report), { contactId: contact.id });
      await patchTask(reportT, task.id, { contactId: null }).expect(200);
      await delContact(reportT, contact.id).expect(204);
    });

    it('a reopened task blocks again', async () => {
      const contact = await createContact(prisma, owned(orgA, report));
      const task = await createTask(prisma, mine(orgA, report), {
        contactId: contact.id,
        status: 'COMPLETED',
      });
      await taskStatus(reportT, task.id, 'OPEN').expect(200);
      expect((await delContact(reportT, contact.id).expect(409)).body.code).toBe(
        'CONTACT_HAS_OPEN_TASKS',
      );
    });

    it('a task of ANOTHER user blocks too (the count is not visibility-scoped)', async () => {
      const contact = await createContact(prisma, owned(orgA, report));
      await createTask(prisma, mine(orgA, repX), { contactId: contact.id });
      expect((await delContact(reportT, contact.id).expect(409)).body.code).toBe(
        'CONTACT_HAS_OPEN_TASKS',
      );
    });

    it('visibility comes first: a hidden or foreign contact is 404 even with open tasks', async () => {
      const hidden = await createContact(prisma, owned(orgA, repX));
      await createTask(prisma, mine(orgA, repX), { contactId: hidden.id });
      const foreign = await createContact(prisma, owned(orgB, repB));
      await createTask(prisma, mine(orgB, repB), { contactId: foreign.id });
      expect((await delContact(reportT, hidden.id).expect(404)).body.code).toBe(
        'RESOURCE_NOT_FOUND',
      );
      await delContact(reportT, foreign.id).expect(404);
      await delContact(repBT, hidden.id).expect(404);
    });

    it('open deals are reported before open tasks', async () => {
      const contact = await createContact(prisma, owned(orgA, report));
      const pipeline = await findDefaultPipeline(prisma, orgA.id);
      await createDeal(
        prisma,
        owned(orgA, report),
        { pipelineId: pipeline.id, stageId: pipeline.stages[0]?.id ?? '' },
        { contactId: contact.id },
      );
      await createTask(prisma, mine(orgA, report), { contactId: contact.id });
      expect((await delContact(reportT, contact.id).expect(409)).body.code).toBe(
        'CONTACT_HAS_OPEN_DEALS',
      );
    });

    it('tasks linked to a different contact do not block this one', async () => {
      const contact = await createContact(prisma, owned(orgA, report));
      const other = await createContact(prisma, owned(orgA, report));
      await createTask(prisma, mine(orgA, report), { contactId: other.id });
      await delContact(reportT, contact.id).expect(204);
    });
  });

  describe('company delete', () => {
    it.each(['OPEN', 'IN_PROGRESS'] as const)(
      'a %s task blocks it: 409 COMPANY_HAS_OPEN_TASKS, no count in the message',
      async (status) => {
        const company = await createCompany(prisma, owned(orgA, report));
        await createTask(prisma, mine(orgA, report), { companyId: company.id, status });
        const res = await delCompany(reportT, company.id).expect(409);
        expect(res.body.code).toBe('COMPANY_HAS_OPEN_TASKS');
        expect(res.body.message).toBe('Company has open tasks and cannot be deleted');
        expect(JSON.stringify(res.body)).not.toMatch(/\d+ task/);
        expect(
          (await prisma.company.findUniqueOrThrow({ where: { id: company.id } })).deletedAt,
        ).toBeNull();
      },
    );

    it.each(['COMPLETED', 'CANCELLED'] as const)('a %s task does not block it', async (status) => {
      const company = await createCompany(prisma, owned(orgA, report));
      await createTask(prisma, mine(orgA, report), { companyId: company.id, status });
      await delCompany(reportT, company.id).expect(204);
    });

    it('a task of ANOTHER user blocks too, and finishing it unblocks', async () => {
      const company = await createCompany(prisma, owned(orgA, report));
      const task = await createTask(prisma, mine(orgA, repX), { companyId: company.id });
      await delCompany(reportT, company.id).expect(409);
      await taskStatus(repXT, task.id, 'CANCELLED').expect(200);
      await delCompany(reportT, company.id).expect(204);
    });

    it('visibility comes first: a hidden or foreign company is 404 even with open tasks', async () => {
      const hidden = await createCompany(prisma, owned(orgA, repX));
      await createTask(prisma, mine(orgA, repX), { companyId: hidden.id });
      const foreign = await createCompany(prisma, owned(orgB, repB));
      await createTask(prisma, mine(orgB, repB), { companyId: foreign.id });
      await delCompany(reportT, hidden.id).expect(404);
      await delCompany(reportT, foreign.id).expect(404);
    });

    it('contacts, then deals, are reported before open tasks', async () => {
      const company = await createCompany(prisma, owned(orgA, report));
      await createTask(prisma, mine(orgA, report), { companyId: company.id });
      const contact = await createContact(prisma, owned(orgA, report), { companyId: company.id });
      expect((await delCompany(reportT, company.id).expect(409)).body.code).toBe(
        'COMPANY_HAS_CONTACTS',
      );
      await prisma.contact.update({ where: { id: contact.id }, data: { deletedAt: new Date() } });

      const pipeline = await findDefaultPipeline(prisma, orgA.id);
      await createDeal(
        prisma,
        owned(orgA, report),
        { pipelineId: pipeline.id, stageId: pipeline.stages[0]?.id ?? '' },
        { companyId: company.id },
      );
      expect((await delCompany(reportT, company.id).expect(409)).body.code).toBe(
        'COMPANY_HAS_DEALS',
      );
    });

    it('an admin hits the same blocker', async () => {
      const company = await createCompany(prisma, owned(orgA, report));
      await createTask(prisma, mine(orgA, report), { companyId: company.id });
      expect((await delCompany(adminT, company.id).expect(409)).body.code).toBe(
        'COMPANY_HAS_OPEN_TASKS',
      );
    });
  });

  describe('locks (deterministic)', () => {
    it('contact delete waits for a task write that holds the shared contact lock, then counts it', async () => {
      const contact = await createContact(prisma, owned(orgA, report));
      const inFlight = await holdLock(prisma, 'contact', contact.id, 'shared');
      const request = delContact(reportT, contact.id).then((r) => r);
      expect(await stillPendingAfter(request)).toBe(true);
      // The "task write" commits its row before releasing the lock, as the real one does.
      await createTask(prisma, mine(orgA, report), { contactId: contact.id });
      inFlight.release();
      expect((await request).status).toBe(409);
      await inFlight.done;
    });

    it('company delete waits for a task write that holds the shared company lock, then counts it', async () => {
      const company = await createCompany(prisma, owned(orgA, report));
      const inFlight = await holdLock(prisma, 'company', company.id, 'shared');
      const request = delCompany(reportT, company.id).then((r) => r);
      expect(await stillPendingAfter(request)).toBe(true);
      await createTask(prisma, mine(orgA, report), { companyId: company.id });
      inFlight.release();
      expect((await request).status).toBe(409);
      await inFlight.done;
    });

    it('linking a task waits for a running delete (exclusive lock) and then sees the record gone', async () => {
      const contact = await createContact(prisma, owned(orgA, report));
      const deleting = await holdLock(prisma, 'contact', contact.id);
      const request = postTask(reportT, { title: 'x', contactId: contact.id }).then((r) => r);
      expect(await stillPendingAfter(request)).toBe(true);
      await prisma.contact.update({ where: { id: contact.id }, data: { deletedAt: new Date() } });
      deleting.release();
      const res = await request;
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_CONTACT');
      await deleting.done;
      expect(await prisma.task.count()).toBe(0);
    });
  });

  describe('races (20 iterations each)', () => {
    const openTasksOnDeletedContacts = () =>
      prisma.task.count({
        where: {
          status: { in: ['OPEN', 'IN_PROGRESS'] },
          contact: { deletedAt: { not: null } },
        },
      });
    const openTasksOnDeletedCompanies = () =>
      prisma.task.count({
        where: {
          status: { in: ['OPEN', 'IN_PROGRESS'] },
          company: { deletedAt: { not: null } },
        },
      });

    it('creating a task for a contact vs. deleting the contact: exactly one side wins', async () => {
      for (let i = 0; i < RACE_ITERATIONS; i += 1) {
        const contact = await createContact(prisma, owned(orgA, report));
        const [created, deleted] = await Promise.all([
          postTask(reportT, { title: `R${i}`, contactId: contact.id }),
          delContact(reportT, contact.id),
        ]);
        expect([201, 400]).toContain(created.status);
        expect([204, 409]).toContain(deleted.status);
        expect(created.status === 201).toBe(deleted.status === 409);
        expect(await openTasksOnDeletedContacts()).toBe(0);
      }
    });

    it('creating a task for a company vs. deleting the company: exactly one side wins', async () => {
      for (let i = 0; i < RACE_ITERATIONS; i += 1) {
        const company = await createCompany(prisma, owned(orgA, report));
        const [created, deleted] = await Promise.all([
          postTask(reportT, { title: `R${i}`, companyId: company.id }),
          delCompany(reportT, company.id),
        ]);
        expect([201, 400]).toContain(created.status);
        expect([204, 409]).toContain(deleted.status);
        expect(created.status === 201).toBe(deleted.status === 409);
        expect(await openTasksOnDeletedCompanies()).toBe(0);
      }
    });

    it('PATCH contactId vs. deleting that contact: exactly one side wins', async () => {
      for (let i = 0; i < RACE_ITERATIONS; i += 1) {
        const contact = await createContact(prisma, owned(orgA, report));
        const task = await createTask(prisma, mine(orgA, report));
        const [linked, deleted] = await Promise.all([
          patchTask(reportT, task.id, { contactId: contact.id }),
          delContact(reportT, contact.id),
        ]);
        expect([200, 400]).toContain(linked.status);
        expect([204, 409]).toContain(deleted.status);
        expect(linked.status === 200).toBe(deleted.status === 409);
        expect(await openTasksOnDeletedContacts()).toBe(0);
      }
    });

    it('PATCH companyId vs. deleting that company: exactly one side wins', async () => {
      for (let i = 0; i < RACE_ITERATIONS; i += 1) {
        const company = await createCompany(prisma, owned(orgA, report));
        const task = await createTask(prisma, mine(orgA, report));
        const [linked, deleted] = await Promise.all([
          patchTask(reportT, task.id, { companyId: company.id }),
          delCompany(reportT, company.id),
        ]);
        expect([200, 400]).toContain(linked.status);
        expect([204, 409]).toContain(deleted.status);
        expect(linked.status === 200).toBe(deleted.status === 409);
        expect(await openTasksOnDeletedCompanies()).toBe(0);
      }
    });
  });
});
