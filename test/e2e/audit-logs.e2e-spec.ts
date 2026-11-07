import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AuditAction } from '../../src/generated/prisma/client';
import { TenantContextService } from '../../src/common/tenant/tenant-context.service';
import { AuditLogsService } from '../../src/modules/audit-logs/audit-logs.service';
import { AuditService } from '../../src/modules/audit-logs/audit.service';
import { ROLE_NAMES } from '../../prisma/seed/permissions';
import type { PrismaClient } from '../../prisma/seed/prisma-client';
import { createDeal, createTask, findDefaultPipeline } from '../factories/crm.factory';
import { createTestPrisma, resetDatabase } from '../factories/database';
import {
  createOrganization,
  createUser,
  TEST_PASSWORD,
  type TestOrganization,
  type TestUser,
} from '../factories/organization.factory';
import { createTestApp } from '../setup/create-test-app';

const API = '/api/v1';
const TEMP_PASSWORD = 'temp-password-9876';
const NEW_PASSWORD = 'a-brand-new-password-42';

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

// ADR 0014: the audit row is written in the transaction of the audited change. Every audited action
// is proven both ways: the row exists after success, and neither the row nor the change exists after
// a failure, including a failure of the audit insert itself.
describe('Audit logs (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let orgA: TestOrganization;
  let orgB: TestOrganization;
  let admin: Tokens;
  let adminB: Tokens;
  let roles: Record<string, string>;
  let pipelineA: Awaited<ReturnType<typeof findDefaultPipeline>>;

  const http = () => request(app.getHttpServer());
  const signIn = async (
    user: Pick<TestUser, 'email' | 'password'>,
    headers: Record<string, string> = {},
  ): Promise<Tokens> =>
    (
      await http()
        .post(`${API}/auth/login`)
        .set(headers)
        .send({ email: user.email, password: user.password })
        .expect(200)
    ).body;
  const as = (tokens: Tokens) => ({ Authorization: `Bearer ${tokens.accessToken}` });
  // The audit table is append-only; the test reset helper may TRUNCATE it (ADR 0014).
  const clearAudit = () => prisma.$executeRawUnsafe('TRUNCATE "AuditLog"');
  const rows = (where: object = {}) =>
    prisma.auditLog.findMany({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const events = async (where: object = {}) => (await rows(where)).map(({ event }) => event);
  const everythingStored = async () => JSON.stringify(await rows());
  const placement = () => ({ pipelineId: pipelineA.id, stageId: pipelineA.stages[0]?.id ?? '' });
  const userBody = (overrides: object = {}) => ({
    email: 'new.user@orga.test',
    firstName: 'New',
    lastName: 'User',
    roleId: roles[ROLE_NAMES.SALES_REP],
    temporaryPassword: TEMP_PASSWORD,
    ...overrides,
  });
  const failNextAudit = () =>
    vi
      .spyOn(app.get(AuditService), 'record')
      .mockRejectedValueOnce(new Error('injected audit failure'));

  beforeAll(async () => {
    app = await createTestApp();
    prisma = createTestPrisma();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    orgA = await createOrganization(prisma, 'orga');
    orgB = await createOrganization(prisma, 'orgb');
    roles = Object.fromEntries(
      (await prisma.role.findMany({ where: { organizationId: orgA.id } })).map((r) => [
        r.name,
        r.id,
      ]),
    );
    pipelineA = await findDefaultPipeline(prisma, orgA.id);
    admin = await signIn(orgA.admin);
    adminB = await signIn(orgB.admin);
    await clearAudit();
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('users', () => {
    it('user.created: row with the new user, never the password; a rejected create writes none', async () => {
      const created = await http().post(`${API}/users`).set(as(admin)).send(userBody()).expect(201);

      const [row] = await rows();
      expect(row).toMatchObject({
        event: 'user.created',
        action: AuditAction.CREATE,
        entityType: 'User',
        entityId: created.body.id,
        actorId: orgA.admin.id,
        organizationId: orgA.id,
        before: null,
        after: {
          email: 'new.user@orga.test',
          firstName: 'New',
          lastName: 'User',
          roleId: roles[ROLE_NAMES.SALES_REP],
          managerId: null,
          isActive: true,
        },
      });
      expect(await everythingStored()).not.toContain(TEMP_PASSWORD);
      expect(await everythingStored()).not.toMatch(/argon2|passwordHash/i);

      await clearAudit();
      await http().post(`${API}/users`).set(as(admin)).send(userBody()).expect(409); // same email
      await http()
        .post(`${API}/users`)
        .set(as(admin))
        .send(userBody({ roleId: 'nope' }))
        .expect(400);
      expect(await rows()).toEqual([]);
    });

    it('user.updated stores old and new email; nothing is recorded when the email did not change', async () => {
      const user = await createUser(prisma, orgA, { email: 'before@orga.test' });

      await http()
        .patch(`${API}/users/${user.id}`)
        .set(as(admin))
        .send({ email: 'after@orga.test' })
        .expect(200);
      const [row] = await rows({ event: 'user.updated' });
      expect(row).toMatchObject({
        entityId: user.id,
        before: { email: 'before@orga.test' },
        after: { email: 'after@orga.test' },
      });

      await clearAudit();
      await http()
        .patch(`${API}/users/${user.id}`)
        .set(as(admin))
        .send({ email: 'after@orga.test' }) // the same email again
        .expect(200);
      expect(await rows()).toEqual([]);

      await http()
        .patch(`${API}/users/${user.id}`)
        .set(as(admin))
        .send({ firstName: 'Renamed' })
        .expect(200);
      const [renamed] = await rows({ event: 'user.updated' });
      expect(renamed.before).toEqual({ firstName: 'Test' });
      expect(renamed.after).toEqual({ firstName: 'Renamed' }); // no email: it did not change
    });

    it('user.role_changed: row on success, none when the change is refused', async () => {
      const user = await createUser(prisma, orgA);
      await http()
        .patch(`${API}/users/${user.id}`)
        .set(as(admin))
        .send({ roleId: roles[ROLE_NAMES.SALES_MANAGER] })
        .expect(200);
      const [row] = await rows({ event: 'user.role_changed' });
      expect(row).toMatchObject({
        action: AuditAction.PERMISSION_CHANGE,
        entityId: user.id,
        before: { roleId: roles[ROLE_NAMES.SALES_REP] },
        after: { roleId: roles[ROLE_NAMES.SALES_MANAGER] },
      });

      await clearAudit();
      await http()
        .patch(`${API}/users/${orgA.admin.id}`)
        .set(as(admin))
        .send({ roleId: roles[ROLE_NAMES.SALES_REP] })
        .expect(403); // cannot change your own role
      expect(await rows()).toEqual([]);
    });

    it('user.deactivated / user.reactivated: one row per real change, none for a refused or repeated call', async () => {
      const user = await createUser(prisma, orgA);
      await http().post(`${API}/users/${user.id}/deactivate`).set(as(admin)).expect(200);
      await http().post(`${API}/users/${user.id}/deactivate`).set(as(admin)).expect(200); // already off
      expect(await events()).toEqual(['user.deactivated']);
      expect((await rows())[0]).toMatchObject({
        before: { isActive: true },
        after: { isActive: false },
      });

      await http().post(`${API}/users/${user.id}/reactivate`).set(as(admin)).expect(200);
      await http().post(`${API}/users/${user.id}/reactivate`).set(as(admin)).expect(200);
      expect(await events()).toEqual(['user.deactivated', 'user.reactivated']);

      await clearAudit();
      await http().post(`${API}/users/${orgA.admin.id}/deactivate`).set(as(admin)).expect(403);
      expect(await rows()).toEqual([]);
    });

    it('user.password_reset: the event alone, never the temporary password', async () => {
      const user = await createUser(prisma, orgA);
      await http()
        .post(`${API}/users/${user.id}/reset-password`)
        .set(as(admin))
        .send({ temporaryPassword: TEMP_PASSWORD })
        .expect(204);
      const [row] = await rows();
      expect(row).toMatchObject({
        event: 'user.password_reset',
        entityId: user.id,
        before: null,
        after: null,
      });
      expect(await everythingStored()).not.toContain(TEMP_PASSWORD);

      await clearAudit();
      await http()
        .post(`${API}/users/${orgA.admin.id}/reset-password`)
        .set(as(admin))
        .send({ temporaryPassword: TEMP_PASSWORD })
        .expect(403);
      expect(await rows()).toEqual([]);
    });
  });

  describe('roles', () => {
    it('role.created / role.updated / role.permissions_changed / role.deleted, and none for refused calls', async () => {
      const created = await http()
        .post(`${API}/roles`)
        .set(as(admin))
        .send({ name: 'Support', permissionKeys: ['leads:read'] })
        .expect(201);
      const id = created.body.id as string;
      expect((await rows())[0]).toMatchObject({
        event: 'role.created',
        entityId: id,
        after: { name: 'Support', permissionKeys: ['leads:read'] },
      });

      await http()
        .patch(`${API}/roles/${id}`)
        .set(as(admin))
        .send({ name: 'Helpdesk', permissionKeys: ['leads:read', 'deals:read'] })
        .expect(200);
      expect(await rows({ event: 'role.updated' })).toMatchObject([
        { before: { name: 'Support' }, after: { name: 'Helpdesk' } },
      ]);
      expect(await rows({ event: 'role.permissions_changed' })).toMatchObject([
        {
          action: AuditAction.PERMISSION_CHANGE,
          before: { permissionKeys: ['leads:read'] },
          after: { permissionKeys: ['deals:read', 'leads:read'] },
        },
      ]);

      // Same name and same permissions again: nothing changed, nothing recorded.
      const count = await prisma.auditLog.count();
      await http()
        .patch(`${API}/roles/${id}`)
        .set(as(admin))
        .send({ name: 'Helpdesk', permissionKeys: ['deals:read', 'leads:read'] })
        .expect(200);
      expect(await prisma.auditLog.count()).toBe(count);

      await http().delete(`${API}/roles/${id}`).set(as(admin)).expect(204);
      expect(await rows({ event: 'role.deleted' })).toMatchObject([
        { entityId: id, before: { name: 'Helpdesk' } },
      ]);

      await clearAudit();
      await http()
        .post(`${API}/roles`)
        .set(as(admin))
        .send({ name: 'admin', permissionKeys: [] })
        .expect(400); // reserved name
      await http().delete(`${API}/roles/${roles[ROLE_NAMES.SALES_REP]}`).set(as(admin)).expect(403);
      expect(await rows()).toEqual([]);
    });

    it('the row outlives the deleted role (no foreign key to the entity)', async () => {
      const created = await http()
        .post(`${API}/roles`)
        .set(as(admin))
        .send({ name: 'Temp', permissionKeys: [] })
        .expect(201);
      await http().delete(`${API}/roles/${created.body.id}`).set(as(admin)).expect(204);
      expect(await prisma.role.count({ where: { id: created.body.id } })).toBe(0);
      expect(await prisma.auditLog.count({ where: { entityId: created.body.id } })).toBe(2);
    });
  });

  describe('organization', () => {
    it('organization.updated: old and new value; none for an empty or invalid update', async () => {
      await http()
        .patch(`${API}/organizations/current`)
        .set(as(admin))
        .send({ name: 'Renamed Corp' })
        .expect(200);
      expect(await rows()).toMatchObject([
        {
          event: 'organization.updated',
          entityType: 'Organization',
          entityId: orgA.id,
          before: { name: 'orga' },
          after: { name: 'Renamed Corp' },
        },
      ]);

      await clearAudit();
      await http().patch(`${API}/organizations/current`).set(as(admin)).send({}).expect(400);
      await http()
        .patch(`${API}/organizations/current`)
        .set(as(admin))
        .send({ defaultCurrency: 'NOPE' })
        .expect(400);
      expect(await rows()).toEqual([]);
    });
  });

  describe('authentication', () => {
    it('a successful login writes exactly one row, with the actor and organization from the database', async () => {
      const tokens = await signIn(orgA.admin, {
        'x-request-id': 'login-req-1',
        'user-agent': 'e2e/1.0',
      });
      expect(tokens.accessToken).toBeTruthy();
      expect(await rows()).toMatchObject([
        {
          event: 'auth.login',
          action: AuditAction.LOGIN,
          entityType: 'User',
          entityId: orgA.admin.id,
          actorId: orgA.admin.id,
          organizationId: orgA.id,
          requestId: 'login-req-1',
          userAgent: 'e2e/1.0',
        },
      ]);
      expect((await rows())[0].ipAddress).toBeTruthy();
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: orgA.admin.id } })).lastLoginAt,
      ).not.toBeNull();
    });

    it('the organization is the user own, even if the request names another one', async () => {
      await http()
        .post(`${API}/auth/login`)
        .send({ email: orgB.admin.email, password: orgB.admin.password, organizationId: orgA.id })
        .expect(400); // unknown property: the request cannot say who it is
      expect(await rows()).toEqual([]);

      await signIn(orgB.admin);
      expect(await rows()).toMatchObject([{ organizationId: orgB.id, actorId: orgB.admin.id }]);
    });

    it('a failed login writes no audit row (structured log only)', async () => {
      await http()
        .post(`${API}/auth/login`)
        .send({ email: orgA.admin.email, password: 'wrong-password-123' })
        .expect(401);
      await http()
        .post(`${API}/auth/login`)
        .send({ email: 'nobody@nowhere.test', password: 'wrong-password-123' })
        .expect(401);
      const inactive = await createUser(prisma, orgA, { isActive: false });
      await http()
        .post(`${API}/auth/login`)
        .send({ email: inactive.email, password: inactive.password })
        .expect(401);
      expect(await rows()).toEqual([]);
    });

    it('logout is audited once; repeating it, or an unknown token, writes nothing', async () => {
      const tokens = await signIn(orgA.admin);
      await clearAudit();
      await http()
        .post(`${API}/auth/logout`)
        .send({ refreshToken: tokens.refreshToken })
        .expect(204);
      expect(await rows()).toMatchObject([
        {
          event: 'auth.logout',
          action: AuditAction.LOGOUT,
          actorId: orgA.admin.id,
          organizationId: orgA.id,
        },
      ]);
      await http()
        .post(`${API}/auth/logout`)
        .send({ refreshToken: tokens.refreshToken })
        .expect(204);
      await http()
        .post(`${API}/auth/logout`)
        .send({ refreshToken: 'x'.repeat(40) })
        .expect(204);
      expect(await prisma.auditLog.count()).toBe(1);
    });

    it('auth.password_changed: the event alone, never a password; a wrong current password writes none', async () => {
      await http()
        .post(`${API}/auth/change-password`)
        .set(as(admin))
        .send({ currentPassword: 'not-the-password-1', newPassword: NEW_PASSWORD })
        .expect(400);
      expect(await rows()).toEqual([]);

      await http()
        .post(`${API}/auth/change-password`)
        .set(as(admin))
        .send({ currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD })
        .expect(200);
      expect(await rows()).toMatchObject([
        { event: 'auth.password_changed', entityId: orgA.admin.id, before: null, after: null },
      ]);
      const stored = await everythingStored();
      expect(stored).not.toContain(NEW_PASSWORD);
      expect(stored).not.toContain(TEST_PASSWORD);
    });
  });

  describe('deals', () => {
    it('deal.money_changed stores amount and currency as strings, only what really changed', async () => {
      const deal = await createDeal(
        prisma,
        { organizationId: orgA.id, ownerId: orgA.admin.id },
        placement(),
        {
          amount: '1250.50',
          currency: 'USD',
        },
      );
      const patch = (body: object) =>
        http().patch(`${API}/deals/${deal.id}`).set(as(admin)).send(body);

      await patch({ amount: '2000' }).expect(200);
      let [row] = await rows({ event: 'deal.money_changed' });
      expect(row).toMatchObject({
        action: AuditAction.UPDATE,
        entityType: 'Deal',
        entityId: deal.id,
        before: { amount: '1250.50' },
        after: { amount: '2000.00' },
      });
      expect(typeof (row.after as { amount: unknown }).amount).toBe('string');

      await clearAudit();
      await patch({ amount: '2000.00' }).expect(200); // the same value
      await patch({ title: 'Renamed' }).expect(200); // not money
      expect(await rows()).toEqual([]);

      await patch({ currency: 'EUR' }).expect(200); // only the currency
      [row] = await rows();
      expect(row.before).toEqual({ currency: 'USD' });
      expect(row.after).toEqual({ currency: 'EUR' });

      await patch({ amount: '10', currency: 'GBP' }).expect(200);
      expect((await rows())[1]).toMatchObject({
        before: { amount: '2000.00', currency: 'EUR' },
        after: { amount: '10.00', currency: 'GBP' },
      });
    });

    it('a closed deal answers 409 and writes no audit row', async () => {
      const deal = await createDeal(
        prisma,
        { organizationId: orgA.id, ownerId: orgA.admin.id },
        placement(),
        {
          status: 'WON',
        },
      );
      await http()
        .patch(`${API}/deals/${deal.id}`)
        .set(as(admin))
        .send({ amount: '5' })
        .expect(409);
      expect(await rows()).toEqual([]);
    });
  });

  describe('tasks', () => {
    it('task.reassigned stores the assignee only; the same assignee or a plain edit writes none', async () => {
      const other = await createUser(prisma, orgA);
      const task = await createTask(
        prisma,
        { organizationId: orgA.id, assigneeId: orgA.admin.id },
        {
          title: 'Secret plan for the quarter',
        },
      );
      const patch = (body: object) =>
        http().patch(`${API}/tasks/${task.id}`).set(as(admin)).send(body);

      await patch({ title: 'Renamed' }).expect(200);
      await patch({ assigneeId: orgA.admin.id }).expect(200); // unchanged
      expect(await rows()).toEqual([]);

      await patch({ assigneeId: other.id }).expect(200);
      expect(await rows()).toMatchObject([
        {
          event: 'task.reassigned',
          entityType: 'Task',
          entityId: task.id,
          before: { assigneeId: orgA.admin.id },
          after: { assigneeId: other.id },
        },
      ]);
      expect(await everythingStored()).not.toContain('Secret plan');
      expect(await everythingStored()).not.toContain('Renamed');
    });

    it('a refused reassignment (stranger, closed task) writes nothing', async () => {
      const foreign = await createUser(prisma, orgB);
      const task = await createTask(prisma, { organizationId: orgA.id, assigneeId: orgA.admin.id });
      await http()
        .patch(`${API}/tasks/${task.id}`)
        .set(as(admin))
        .send({ assigneeId: foreign.id })
        .expect(400);
      const closed = await createTask(
        prisma,
        { organizationId: orgA.id, assigneeId: orgA.admin.id },
        {
          status: 'COMPLETED',
        },
      );
      const other = await createUser(prisma, orgA);
      await http()
        .patch(`${API}/tasks/${closed.id}`)
        .set(as(admin))
        .send({ assigneeId: other.id })
        .expect(409);
      expect(await rows()).toEqual([]);
    });

    it('task.deleted stores the assignee only, and outlives the task', async () => {
      const task = await createTask(
        prisma,
        { organizationId: orgA.id, assigneeId: orgA.admin.id },
        { title: 'Call the CEO about the merger' },
      );
      await prisma.task.update({
        where: { id: task.id },
        data: { description: 'confidential details' },
      });
      await http().delete(`${API}/tasks/${task.id}`).set(as(admin)).expect(204);
      expect(await rows()).toMatchObject([
        {
          event: 'task.deleted',
          action: AuditAction.DELETE,
          entityId: task.id,
          before: { assigneeId: orgA.admin.id },
          after: null,
        },
      ]);
      expect(await prisma.task.count({ where: { id: task.id } })).toBe(0);
      expect(await everythingStored()).not.toMatch(/merger|confidential/);

      await clearAudit();
      await http().delete(`${API}/tasks/${task.id}`).set(as(admin)).expect(404);
      expect(await rows()).toEqual([]);
    });
  });

  // The decision of ADR 0014, proven: if the audit insert fails, the audited change does not happen.
  describe('fail-closed: an audit insert failure rolls the business change back', () => {
    it('user create, deactivation and password reset', async () => {
      const user = await createUser(prisma, orgA);
      const users = await prisma.user.count();

      failNextAudit();
      await http().post(`${API}/users`).set(as(admin)).send(userBody()).expect(500);
      expect(await prisma.user.count()).toBe(users);

      failNextAudit();
      await http().post(`${API}/users/${user.id}/deactivate`).set(as(admin)).expect(500);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).isActive).toBe(true);

      const before = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash;
      failNextAudit();
      await http()
        .post(`${API}/users/${user.id}/reset-password`)
        .set(as(admin))
        .send({ temporaryPassword: TEMP_PASSWORD })
        .expect(500);
      const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(after.passwordHash).toBe(before);
      expect(after.mustChangePassword).toBe(false);
      expect(await rows()).toEqual([]);
    });

    it('role delete and organization update', async () => {
      const role = await prisma.role.create({ data: { organizationId: orgA.id, name: 'Temp' } });
      failNextAudit();
      await http().delete(`${API}/roles/${role.id}`).set(as(admin)).expect(500);
      expect(await prisma.role.count({ where: { id: role.id } })).toBe(1);

      failNextAudit();
      await http()
        .patch(`${API}/organizations/current`)
        .set(as(admin))
        .send({ name: 'Never applied' })
        .expect(500);
      expect((await prisma.organization.findUniqueOrThrow({ where: { id: orgA.id } })).name).toBe(
        'orga',
      );
      expect(await rows()).toEqual([]);
    });

    it('login: no session is created and no token is handed out', async () => {
      failNextAudit();
      const res = await http()
        .post(`${API}/auth/login`)
        .send({ email: orgA.admin.email, password: orgA.admin.password })
        .expect(500);
      expect(res.body.accessToken).toBeUndefined();
      expect(res.body.refreshToken).toBeUndefined();
      expect(await prisma.refreshToken.count({ where: { userId: orgA.admin.id } })).toBe(1); // the one from beforeEach
      expect(await rows()).toEqual([]);
    });

    it('logout keeps the session alive; password change keeps the old password', async () => {
      const tokens = await signIn(orgA.admin);
      await clearAudit();
      failNextAudit();
      await http()
        .post(`${API}/auth/logout`)
        .send({ refreshToken: tokens.refreshToken })
        .expect(500);
      await http()
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: tokens.refreshToken })
        .expect(200);

      const hash = (await prisma.user.findUniqueOrThrow({ where: { id: orgA.admin.id } }))
        .passwordHash;
      failNextAudit();
      await http()
        .post(`${API}/auth/change-password`)
        .set(as(tokens))
        .send({ currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD })
        .expect(500);
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: orgA.admin.id } })).passwordHash,
      ).toBe(hash);
      await signIn(orgA.admin); // the old password still works
    });

    it('deal amount, task reassignment and task delete', async () => {
      const deal = await createDeal(
        prisma,
        { organizationId: orgA.id, ownerId: orgA.admin.id },
        placement(),
        {
          amount: '100.00',
        },
      );
      failNextAudit();
      await http()
        .patch(`${API}/deals/${deal.id}`)
        .set(as(admin))
        .send({ amount: '999' })
        .expect(500);
      expect(
        (await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } })).amount.toFixed(2),
      ).toBe('100.00');

      const other = await createUser(prisma, orgA);
      const task = await createTask(prisma, { organizationId: orgA.id, assigneeId: orgA.admin.id });
      failNextAudit();
      await http()
        .patch(`${API}/tasks/${task.id}`)
        .set(as(admin))
        .send({ assigneeId: other.id })
        .expect(500);
      expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).assigneeId).toBe(
        orgA.admin.id,
      );

      failNextAudit();
      await http().delete(`${API}/tasks/${task.id}`).set(as(admin)).expect(500);
      expect(await prisma.task.count({ where: { id: task.id } })).toBe(1);
      expect(await rows()).toEqual([]);
    });
  });

  describe('GET /audit-logs', () => {
    const list = (tokens: Tokens, query = '') =>
      http().get(`${API}/audit-logs${query}`).set(as(tokens));

    // Direct inserts with explicit instants make the order and the paging deterministic.
    const seed = (organizationId: string, count: number, overrides: object = {}) =>
      prisma.auditLog.createMany({
        data: Array.from({ length: count }, (_, i) => ({
          organizationId,
          event: 'user.updated',
          action: AuditAction.UPDATE,
          entityType: 'User',
          entityId: crypto.randomUUID(),
          createdAt: new Date(Date.UTC(2026, 5, 1, 0, 0, i)),
          ...overrides,
        })),
      });

    it('is for administrators only: 401 anonymous, 403 for a rep and a manager', async () => {
      await http().get(`${API}/audit-logs`).expect(401);
      const rep = await signIn(await createUser(prisma, orgA, { role: ROLE_NAMES.SALES_REP }));
      const manager = await signIn(
        await createUser(prisma, orgA, { role: ROLE_NAMES.SALES_MANAGER }),
      );
      await list(rep).expect(403);
      await list(manager).expect(403);
      await list(admin).expect(200);
    });

    it('an admin sees only their own organization', async () => {
      await seed(orgA.id, 3);
      await seed(orgB.id, 4, { event: 'user.deactivated' });
      const own = await list(admin, '?limit=100').expect(200);
      expect(own.body.data).toHaveLength(3);
      expect(await prisma.auditLog.count({ where: { organizationId: orgB.id } })).toBe(4);
      for (const entry of own.body.data) expect(entry.event).toBe('user.updated');

      const theirs = await list(adminB, '?limit=100').expect(200);
      expect(theirs.body.data).toHaveLength(4);

      // Asking for org B's records by id, or with org B's cursor, reveals nothing.
      const [foreign] = await rows({ organizationId: orgB.id });
      const byId = await list(admin, `?entityId=${foreign.entityId}`).expect(200);
      expect(byId.body.data).toEqual([]);

      const page = await list(adminB, '?limit=2').expect(200);
      await list(admin, `?cursor=${page.body.meta.nextCursor}`).expect(400);
    });

    it('returns the documented fields, ip and user agent included, and no total count', async () => {
      await http()
        .patch(`${API}/organizations/current`)
        .set(as(admin))
        .set({ 'user-agent': 'audit-e2e/2.0', 'x-request-id': 'req-xyz' })
        .send({ name: 'Visible change' })
        .expect(200);
      const res = await list(admin).expect(200);
      expect(res.body.meta).toEqual({ limit: expect.any(Number), nextCursor: null });
      expect(res.body.meta).not.toHaveProperty('total');
      expect(res.body.data[0]).toEqual({
        id: expect.any(String),
        event: 'organization.updated',
        action: 'UPDATE',
        entityType: 'Organization',
        entityId: orgA.id,
        actorId: orgA.admin.id,
        before: { name: 'orga' },
        after: { name: 'Visible change' },
        ipAddress: expect.any(String),
        userAgent: 'audit-e2e/2.0',
        requestId: 'req-xyz',
        createdAt: expect.any(String),
      });
    });

    it('no other endpoint exposes the ip address or the user agent', async () => {
      await http().get(`${API}/auth/me`).set(as(admin)).expect(200);
      const bodies = [
        (await http().get(`${API}/auth/me`).set(as(admin)).expect(200)).body,
        (await http().get(`${API}/users/${orgA.admin.id}`).set(as(admin)).expect(200)).body,
        (await http().get(`${API}/users`).set(as(admin)).expect(200)).body,
        (await http().get(`${API}/organizations/current`).set(as(admin)).expect(200)).body,
      ];
      for (const body of bodies) {
        expect(JSON.stringify(body)).not.toMatch(/ipAddress|userAgent|requestId/);
      }
    });

    it('filters by actor, entity, event, action and date range', async () => {
      const other = await createUser(prisma, orgA);
      await seed(orgA.id, 4, { actorId: orgA.admin.id });
      await seed(orgA.id, 2, {
        actorId: other.id,
        event: 'user.deactivated',
        entityType: 'User',
        createdAt: new Date(Date.UTC(2026, 6, 1)),
      });
      await seed(orgA.id, 1, {
        event: 'task.deleted',
        action: AuditAction.DELETE,
        entityType: 'Task',
      });

      const count = async (query: string) =>
        (await list(admin, `${query}&limit=100`).expect(200)).body.data.length;
      expect(await count(`?actorId=${other.id}`)).toBe(2);
      expect(await count(`?event=user.deactivated`)).toBe(2);
      expect(await count(`?entityType=Task`)).toBe(1);
      expect(await count(`?action=DELETE`)).toBe(1);
      expect(await count(`?from=2026-07-01T00:00:00Z`)).toBe(2);
      expect(await count(`?to=2026-06-02T00:00:00Z`)).toBe(5);
      expect(
        await count(`?from=2026-06-01T00:00:01Z&to=2026-06-01T00:00:02Z&entityType=User`),
      ).toBe(2);
      const [one] = await rows({ event: 'task.deleted' });
      expect(await count(`?entityType=Task&entityId=${one.entityId}`)).toBe(1);

      await list(admin, '?event=not.an.event').expect(400);
      await list(admin, '?entityType=Planet').expect(400);
      await list(admin, '?actorId=nope').expect(400);
      await list(admin, '?from=yesterday').expect(400);
      await list(admin, '?limit=1000').expect(400);
    });

    it('cursor pages are stable while new rows arrive: no duplicate, no gap', async () => {
      await seed(orgA.id, 7);
      const originals = (await rows({ organizationId: orgA.id })).map(({ id }) => id);

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res: request.Response = await list(
          admin,
          `?limit=3${cursor ? `&cursor=${cursor}` : ''}`,
        ).expect(200);
        seen.push(...res.body.data.map((entry: { id: string }) => entry.id));
        cursor = res.body.meta.nextCursor;
        pages += 1;
        // New activity lands between the pages (newest first, so it sits ABOVE the cursor).
        await http()
          .patch(`${API}/organizations/current`)
          .set(as(admin))
          .send({ name: `Change ${pages}` })
          .expect(200);
      } while (cursor);

      expect(pages).toBe(3);
      expect(new Set(seen).size).toBe(seen.length); // no duplicate
      for (const id of originals) expect(seen).toContain(id); // no gap among what existed at the start
      // The 7 seeded rows are dated June 2026; everything new is later, so they come out newest-last.
      expect(seen).toEqual([...originals].reverse());
    });

    it('reading the audit log is not itself audited', async () => {
      await seed(orgA.id, 2);
      const count = await prisma.auditLog.count();
      await list(admin).expect(200);
      await list(admin, '?event=user.updated&limit=1').expect(200);
      expect(await prisma.auditLog.count()).toBe(count);
    });
  });

  describe('retention', () => {
    const DAY = 86_400_000;
    const insertAged = (organizationId: string, ageDays: number, n = 1) =>
      prisma.auditLog.createMany({
        data: Array.from({ length: n }, () => ({
          organizationId,
          event: 'user.updated',
          action: AuditAction.UPDATE,
          entityType: 'User',
          entityId: crypto.randomUUID(),
          createdAt: new Date(Date.now() - ageDays * DAY),
        })),
      });
    const purge = (organizationId: string) =>
      app
        .get(TenantContextService)
        .run(organizationId, () => app.get(AuditLogsService).purgeExpired(new Date()));
    const flags = () =>
      Promise.all(
        Array.from(
          { length: 20 },
          async () =>
            (
              await prisma.$queryRaw<
                { value: string | null }[]
              >`SELECT current_setting('app.audit_retention', true) AS value`
            )[0].value,
        ),
      );

    it('deletes only expired rows of the job organization, then the flag is gone', async () => {
      await insertAged(orgA.id, 800, 3); // past the 730-day default
      await insertAged(orgA.id, 10, 2); // recent
      await insertAged(orgB.id, 800, 2); // another organization: not this job's business

      expect(await purge(orgA.id)).toBe(3);
      expect(await prisma.auditLog.count({ where: { organizationId: orgA.id } })).toBe(2);
      expect(await prisma.auditLog.count({ where: { organizationId: orgB.id } })).toBe(2);

      expect((await flags()).filter((value) => value === 'on')).toEqual([]);
      // Outside the job the trigger is back in force.
      await expect(prisma.auditLog.deleteMany({})).rejects.toThrow(/append-only/);
      expect(await prisma.auditLog.count()).toBe(4);
    });

    it('is idempotent and bounded: a second run finds nothing', async () => {
      await insertAged(orgA.id, 900, 5);
      expect(await purge(orgA.id)).toBe(5);
      expect(await purge(orgA.id)).toBe(0);
    });
  });
});
