import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '../../prisma/seed/prisma-client';
import { ROLE_NAMES } from '../../prisma/seed/permissions';
import { createTestPrisma, resetDatabase } from '../factories/database';
import {
  createCustomRole,
  createOrganization,
  createUser,
  TEST_PASSWORD,
  type TestOrganization,
  type TestUser,
} from '../factories/organization.factory';
import { createTestApp } from '../setup/create-test-app';

const API = '/api/v1';
const TEMP_PASSWORD = 'temp-password-9876';

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

describe('Users (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let orgA: TestOrganization;
  let orgB: TestOrganization;
  let roles: Record<string, string>; // org A role name -> id
  let rolesB: Record<string, string>;

  const http = () => request(app.getHttpServer());
  const creds = ({ email, password }: Pick<TestUser, 'email' | 'password'>) => ({
    email,
    password,
  });
  const signIn = async (user: Pick<TestUser, 'email' | 'password'>): Promise<Tokens> =>
    (await http().post(`${API}/auth/login`).send(creds(user)).expect(200)).body;
  const as = (tokens: Tokens) => ({ Authorization: `Bearer ${tokens.accessToken}` });
  const roleIds = async (organizationId: string): Promise<Record<string, string>> =>
    Object.fromEntries(
      (await prisma.role.findMany({ where: { organizationId } })).map((r) => [r.name, r.id]),
    );
  const row = (id: string) => prisma.user.findUniqueOrThrow({ where: { id } });

  let admin: Tokens;

  const createBody = (overrides: object = {}) => ({
    email: 'new.user@orga.test',
    firstName: 'New',
    lastName: 'User',
    roleId: roles[ROLE_NAMES.SALES_REP],
    temporaryPassword: TEMP_PASSWORD,
    ...overrides,
  });

  beforeAll(async () => {
    app = await createTestApp();
    prisma = createTestPrisma();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    orgA = await createOrganization(prisma, 'orga');
    orgB = await createOrganization(prisma, 'orgb');
    roles = await roleIds(orgA.id);
    rolesB = await roleIds(orgB.id);
    admin = await signIn(orgA.admin);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('authorization (RBAC)', () => {
    it('requires authentication', async () => {
      await http().get(`${API}/users`).expect(401);
    });

    it('a SALES_REP has no users permissions', async () => {
      const rep = await signIn(await createUser(prisma, orgA, { role: ROLE_NAMES.SALES_REP }));
      await http().get(`${API}/users`).set(as(rep)).expect(403);
    });

    it('a SALES_MANAGER can read (the whole organization) but not write', async () => {
      const manager = await signIn(
        await createUser(prisma, orgA, { role: ROLE_NAMES.SALES_MANAGER }),
      );
      const list = await http().get(`${API}/users`).set(as(manager)).expect(200);
      expect(list.body.meta.total).toBe(2); // the admin and the manager
      await http().post(`${API}/users`).set(as(manager)).send(createBody()).expect(403);
      await http().post(`${API}/users/${orgA.admin.id}/deactivate`).set(as(manager)).expect(403);
    });
  });

  describe('POST /users', () => {
    it('creates a user that must change the password, and never echoes a password', async () => {
      const res = await http().post(`${API}/users`).set(as(admin)).send(createBody()).expect(201);

      expect(res.body).toMatchObject({
        email: 'new.user@orga.test',
        isActive: true,
        mustChangePassword: true,
        managerId: null,
        role: { name: ROLE_NAMES.SALES_REP },
      });
      for (const field of ['password', 'temporaryPassword', 'passwordHash']) {
        expect(res.body).not.toHaveProperty(field);
      }
      expect(JSON.stringify(res.body)).not.toContain(TEMP_PASSWORD);
      expect(res.body.passwordHash).toBeUndefined();

      const login = await http()
        .post(`${API}/auth/login`)
        .send({ email: 'new.user@orga.test', password: TEMP_PASSWORD })
        .expect(200);
      expect(login.body.mustChangePassword).toBe(true);
    });

    it('lowercases the email and puts the user in the caller organization', async () => {
      const res = await http()
        .post(`${API}/users`)
        .set(as(admin))
        .send(createBody({ email: '  Mixed.Case@OrgA.test ' }))
        .expect(201);
      expect(res.body.email).toBe('mixed.case@orga.test');
      expect((await row(res.body.id)).organizationId).toBe(orgA.id);
    });

    it('rejects invalid input and an organizationId in the body (400)', async () => {
      const post = (body: object) => http().post(`${API}/users`).set(as(admin)).send(body);
      await post(createBody({ email: 'not-an-email' })).expect(400);
      await post(createBody({ firstName: '' })).expect(400);
      await post(createBody({ roleId: 'nope' })).expect(400);
      await post(createBody({ organizationId: orgB.id })).expect(400);
    });

    it('rejects a weak temporary password (400 WEAK_PASSWORD)', async () => {
      const res = await http()
        .post(`${API}/users`)
        .set(as(admin))
        .send(createBody({ temporaryPassword: 'short' }))
        .expect(400);
      expect(res.body.code).toBe('WEAK_PASSWORD');
    });

    it('answers 409 EMAIL_ALREADY_EXISTS, also across organizations, without naming one', async () => {
      const other = await createUser(prisma, orgB, { email: 'taken@orgb.test' });
      const res = await http()
        .post(`${API}/users`)
        .set(as(admin))
        .send(createBody({ email: other.email }))
        .expect(409);
      expect(res.body.code).toBe('EMAIL_ALREADY_EXISTS');
      expect(res.body.message.toLowerCase()).not.toContain('organization');

      await http()
        .post(`${API}/users`)
        .set(as(admin))
        .send(createBody({ email: orgA.admin.email }))
        .expect(409);
    });

    it('two concurrent creates with the same email: one 201, one 409', async () => {
      const results = await Promise.all([
        http().post(`${API}/users`).set(as(admin)).send(createBody()),
        http().post(`${API}/users`).set(as(admin)).send(createBody()),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(results.find((r) => r.status === 409)?.body.code).toBe('EMAIL_ALREADY_EXISTS');
    });

    it('rejects a role or manager from another organization (400)', async () => {
      const foreignRole = await http()
        .post(`${API}/users`)
        .set(as(admin))
        .send(createBody({ roleId: rolesB[ROLE_NAMES.SALES_REP] }))
        .expect(400);
      expect(foreignRole.body.code).toBe('INVALID_ROLE');

      const foreignManager = await http()
        .post(`${API}/users`)
        .set(as(admin))
        .send(createBody({ managerId: orgB.admin.id }))
        .expect(400);
      expect(foreignManager.body.code).toBe('INVALID_MANAGER');
    });
  });

  describe('GET /users', () => {
    it('lists with pagination, search and filters', async () => {
      await createUser(prisma, orgA, { email: 'alice@orga.test' });
      await createUser(prisma, orgA, { email: 'bob@orga.test', isActive: false });
      await createUser(prisma, orgB, { email: 'zed@orgb.test' });

      const all = await http().get(`${API}/users`).set(as(admin)).expect(200);
      expect(all.body.meta).toMatchObject({ page: 1, total: 3 });
      expect(all.body.data.map((u: { email: string }) => u.email)).not.toContain('zed@orgb.test');
      expect(JSON.stringify(all.body)).not.toContain('passwordHash');

      const page = await http().get(`${API}/users?limit=1&page=2`).set(as(admin)).expect(200);
      expect(page.body.data).toHaveLength(1);
      expect(page.body.meta).toMatchObject({ page: 2, limit: 1, total: 3, totalPages: 3 });

      const search = await http().get(`${API}/users?search=ALICE`).set(as(admin)).expect(200);
      expect(search.body.data.map((u: { email: string }) => u.email)).toEqual(['alice@orga.test']);

      const inactive = await http().get(`${API}/users?isActive=false`).set(as(admin)).expect(200);
      expect(inactive.body.data.map((u: { email: string }) => u.email)).toEqual(['bob@orga.test']);

      const byRole = await http()
        .get(`${API}/users?roleId=${roles[ROLE_NAMES.ADMIN]}`)
        .set(as(admin))
        .expect(200);
      expect(byRole.body.meta.total).toBe(1);
    });

    it('sorts by a whitelisted field and rejects anything else (400)', async () => {
      await createUser(prisma, orgA, { email: 'alice@orga.test' });
      const sorted = await http()
        .get(`${API}/users?sortBy=email&sortOrder=asc`)
        .set(as(admin))
        .expect(200);
      const emails = sorted.body.data.map((u: { email: string }) => u.email);
      expect(emails).toEqual([...emails].sort());

      for (const field of ['passwordHash', 'organizationId', 'role']) {
        const res = await http().get(`${API}/users?sortBy=${field}`).set(as(admin)).expect(400);
        expect(res.body.code).toBe('INVALID_SORT_FIELD');
      }
      await http().get(`${API}/users?isActive=maybe`).set(as(admin)).expect(400);
    });
  });

  describe('PATCH /users/:id', () => {
    it('updates profile, role and manager, and removes the manager with null', async () => {
      const target = await createUser(prisma, orgA);
      const boss = await createUser(prisma, orgA, { role: ROLE_NAMES.SALES_MANAGER });

      const res = await http()
        .patch(`${API}/users/${target.id}`)
        .set(as(admin))
        .send({
          firstName: 'Renamed',
          roleId: roles[ROLE_NAMES.SALES_MANAGER],
          managerId: boss.id,
        })
        .expect(200);
      expect(res.body).toMatchObject({
        firstName: 'Renamed',
        managerId: boss.id,
        role: { name: ROLE_NAMES.SALES_MANAGER },
      });

      const cleared = await http()
        .patch(`${API}/users/${target.id}`)
        .set(as(admin))
        .send({ managerId: null })
        .expect(200);
      expect(cleared.body.managerId).toBeNull();
    });

    it('rejects a duplicate email (409) and unknown fields (400)', async () => {
      const target = await createUser(prisma, orgA);
      const res = await http()
        .patch(`${API}/users/${target.id}`)
        .set(as(admin))
        .send({ email: orgA.admin.email })
        .expect(409);
      expect(res.body.code).toBe('EMAIL_ALREADY_EXISTS');
      await http()
        .patch(`${API}/users/${target.id}`)
        .set(as(admin))
        .send({ isActive: false })
        .expect(400);
    });

    it('cannot change your own role, but may edit your own profile', async () => {
      const res = await http()
        .patch(`${API}/users/${orgA.admin.id}`)
        .set(as(admin))
        .send({ roleId: roles[ROLE_NAMES.SALES_REP] })
        .expect(403);
      expect(res.body.code).toBe('CANNOT_CHANGE_OWN_ROLE');
      await http()
        .patch(`${API}/users/${orgA.admin.id}`)
        .set(as(admin))
        .send({ firstName: 'Boss', roleId: roles[ROLE_NAMES.ADMIN] })
        .expect(200);
    });

    it('rejects a manager that is the user, inactive, or would form a cycle', async () => {
      const a = await createUser(prisma, orgA);
      const b = await createUser(prisma, orgA, { managerId: a.id });
      const inactive = await createUser(prisma, orgA, { isActive: false });
      const patch = (id: string, managerId: string) =>
        http().patch(`${API}/users/${id}`).set(as(admin)).send({ managerId });

      for (const res of [
        await patch(a.id, a.id),
        await patch(a.id, b.id),
        await patch(a.id, inactive.id),
      ]) {
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_MANAGER');
      }
    });

    it('two concurrent assignments that would form a cycle: exactly one is rejected', async () => {
      const x = await createUser(prisma, orgA);
      const y = await createUser(prisma, orgA);
      const results = await Promise.all([
        http().patch(`${API}/users/${x.id}`).set(as(admin)).send({ managerId: y.id }),
        http().patch(`${API}/users/${y.id}`).set(as(admin)).send({ managerId: x.id }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
      expect(results.find((r) => r.status === 400)?.body.code).toBe('INVALID_MANAGER');
      const [rx, ry] = await Promise.all([row(x.id), row(y.id)]);
      expect([rx.managerId, ry.managerId].filter(Boolean)).toHaveLength(1);
    });
  });

  describe('deactivate / reactivate', () => {
    it('locks the user out immediately and kills their refresh token', async () => {
      const victim = await createUser(prisma, orgA);
      const tokens = await signIn(victim);

      const res = await http()
        .post(`${API}/users/${victim.id}/deactivate`)
        .set(as(admin))
        .expect(200);
      expect(res.body.isActive).toBe(false);

      await http().get(`${API}/auth/me`).set(as(tokens)).expect(401);
      await http()
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: tokens.refreshToken })
        .expect(401);
      await http().post(`${API}/auth/login`).send(creds(victim)).expect(401);
    });

    it('is idempotent, and reactivation restores access', async () => {
      const victim = await createUser(prisma, orgA);
      await http().post(`${API}/users/${victim.id}/deactivate`).set(as(admin)).expect(200);
      await http().post(`${API}/users/${victim.id}/deactivate`).set(as(admin)).expect(200);
      const res = await http()
        .post(`${API}/users/${victim.id}/reactivate`)
        .set(as(admin))
        .expect(200);
      expect(res.body.isActive).toBe(true);
      await http().post(`${API}/auth/login`).send(creds(victim)).expect(200);
    });

    it('refuses to deactivate yourself', async () => {
      const res = await http()
        .post(`${API}/users/${orgA.admin.id}/deactivate`)
        .set(as(admin))
        .expect(403);
      expect(res.body.code).toBe('CANNOT_DEACTIVATE_SELF');
    });

    it('lets one admin remove another while an active admin remains', async () => {
      const second = await createUser(prisma, orgA, { role: ROLE_NAMES.ADMIN });
      await http().post(`${API}/users/${second.id}/deactivate`).set(as(admin)).expect(200);
    });

    it('refuses while the user has active reports (409), and works once they are moved', async () => {
      const boss = await createUser(prisma, orgA, { role: ROLE_NAMES.SALES_MANAGER });
      const report = await createUser(prisma, orgA, { managerId: boss.id });
      const res = await http()
        .post(`${API}/users/${boss.id}/deactivate`)
        .set(as(admin))
        .expect(409);
      expect(res.body.code).toBe('USER_HAS_ACTIVE_REPORTS');

      await http()
        .patch(`${API}/users/${report.id}`)
        .set(as(admin))
        .send({ managerId: null })
        .expect(200);
      await http().post(`${API}/users/${boss.id}/deactivate`).set(as(admin)).expect(200);
    });

    it('reactivating a user whose manager is inactive fails until the manager is fixed', async () => {
      const boss = await createUser(prisma, orgA, { role: ROLE_NAMES.SALES_MANAGER });
      const report = await createUser(prisma, orgA, { managerId: boss.id });
      await http().post(`${API}/users/${report.id}/deactivate`).set(as(admin)).expect(200);
      await http().post(`${API}/users/${boss.id}/deactivate`).set(as(admin)).expect(200);

      const res = await http()
        .post(`${API}/users/${report.id}/reactivate`)
        .set(as(admin))
        .expect(409);
      expect(res.body.code).toBe('INVALID_MANAGER');
      expect((await row(report.id)).isActive).toBe(false);

      await http()
        .patch(`${API}/users/${report.id}`)
        .set(as(admin))
        .send({ managerId: null })
        .expect(200);
      await http().post(`${API}/users/${report.id}/reactivate`).set(as(admin)).expect(200);
    });

    it('two admins deactivating each other at once never leaves the organization without one', async () => {
      const second = await createUser(prisma, orgA, { role: ROLE_NAMES.ADMIN });
      const secondTokens = await signIn(second);

      const results = await Promise.all([
        http().post(`${API}/users/${second.id}/deactivate`).set(as(admin)),
        http().post(`${API}/users/${orgA.admin.id}/deactivate`).set(as(secondTokens)),
      ]);

      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      const loser = results.find((r) => r.status !== 200);
      // 409 when the second request got past the guard, 401 when the first already locked it out.
      expect([409, 401]).toContain(loser?.status);
      const activeAdmins = await prisma.user.count({
        where: { organizationId: orgA.id, isActive: true, role: { name: ROLE_NAMES.ADMIN } },
      });
      expect(activeAdmins).toBe(1);
    });

    it('deactivating a manager while a report is assigned to them never strands an active user', async () => {
      const boss = await createUser(prisma, orgA, { role: ROLE_NAMES.SALES_MANAGER });
      const report = await createUser(prisma, orgA);

      const [deactivate, assign] = await Promise.all([
        http().post(`${API}/users/${boss.id}/deactivate`).set(as(admin)),
        http().patch(`${API}/users/${report.id}`).set(as(admin)).send({ managerId: boss.id }),
      ]);

      // Either order is fine; both succeeding is not.
      expect([deactivate.status, assign.status].sort()).not.toEqual([200, 200]);
      const [b, r] = await Promise.all([row(boss.id), row(report.id)]);
      expect(r.managerId === boss.id && r.isActive && !b.isActive).toBe(false);
    });
  });

  describe('POST /users/:id/reset-password', () => {
    it('revokes sessions, forces a change, and returns nothing', async () => {
      const victim = await createUser(prisma, orgA);
      const old = await signIn(victim);

      const res = await http()
        .post(`${API}/users/${victim.id}/reset-password`)
        .set(as(admin))
        .send({ temporaryPassword: TEMP_PASSWORD })
        .expect(204);
      expect(res.text).toBe('');

      await http().post(`${API}/auth/refresh`).send({ refreshToken: old.refreshToken }).expect(401);
      await http()
        .post(`${API}/auth/login`)
        .send({ email: victim.email, password: TEST_PASSWORD })
        .expect(401);
      const login = await http()
        .post(`${API}/auth/login`)
        .send({ email: victim.email, password: TEMP_PASSWORD })
        .expect(200);
      expect(login.body.mustChangePassword).toBe(true);
      expect(JSON.stringify(login.body)).not.toContain(TEMP_PASSWORD);
    });

    it('rejects weak passwords, self-reset and unknown fields', async () => {
      const weak = await http()
        .post(`${API}/users/${(await createUser(prisma, orgA)).id}/reset-password`)
        .set(as(admin))
        .send({ temporaryPassword: 'short' })
        .expect(400);
      expect(weak.body.code).toBe('WEAK_PASSWORD');

      const self = await http()
        .post(`${API}/users/${orgA.admin.id}/reset-password`)
        .set(as(admin))
        .send({ temporaryPassword: TEMP_PASSWORD })
        .expect(403);
      expect(self.body.code).toBe('CANNOT_RESET_OWN_PASSWORD');

      await http()
        .post(`${API}/users/${orgA.admin.id}/reset-password`)
        .set(as(admin))
        .send({ temporaryPassword: TEMP_PASSWORD, extra: 1 })
        .expect(400);
    });
  });

  describe('privilege escalation', () => {
    let support: Tokens;
    let supportUser: TestUser;
    let secondAdmin: TestUser;
    let supportRoleId: string;

    beforeEach(async () => {
      const role = await createCustomRole(prisma, orgA, 'SUPPORT', [
        'users:read',
        'users:create',
        'users:update',
      ]);
      supportRoleId = role.id;
      supportUser = await createUser(prisma, orgA, { role: role.name });
      support = await signIn(supportUser);
      secondAdmin = await createUser(prisma, orgA, { role: ROLE_NAMES.ADMIN });
    });

    it('a custom role with users:update cannot modify, reset or deactivate an ADMIN', async () => {
      const attempts = [
        http().patch(`${API}/users/${secondAdmin.id}`).set(as(support)).send({ firstName: 'Pwn' }),
        http()
          .patch(`${API}/users/${secondAdmin.id}`)
          .set(as(support))
          .send({ roleId: roles[ROLE_NAMES.SALES_REP] }),
        http().post(`${API}/users/${secondAdmin.id}/deactivate`).set(as(support)),
        http().post(`${API}/users/${secondAdmin.id}/reactivate`).set(as(support)),
        http()
          .post(`${API}/users/${secondAdmin.id}/reset-password`)
          .set(as(support))
          .send({ temporaryPassword: TEMP_PASSWORD }),
      ];
      for (const res of await Promise.all(attempts)) {
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ADMIN_REQUIRED');
      }
      const unchanged = await row(secondAdmin.id);
      expect(unchanged.firstName).toBe('Test');
      expect(unchanged.isActive).toBe(true);
      await http().post(`${API}/auth/login`).send(creds(secondAdmin)).expect(200);
    });

    it('cannot assign the ADMIN role, to someone else, to itself, or on create', async () => {
      const rep = await createUser(prisma, orgA);
      const toOther = await http()
        .patch(`${API}/users/${rep.id}`)
        .set(as(support))
        .send({ roleId: roles[ROLE_NAMES.ADMIN] })
        .expect(403);
      expect(toOther.body.code).toBe('ADMIN_REQUIRED');
      await http()
        .patch(`${API}/users/${supportUser.id}`)
        .set(as(support))
        .send({ roleId: roles[ROLE_NAMES.ADMIN] })
        .expect(403);
      const created = await http()
        .post(`${API}/users`)
        .set(as(support))
        .send(createBody({ roleId: roles[ROLE_NAMES.ADMIN] }))
        .expect(403);
      expect(created.body.code).toBe('ADMIN_REQUIRED');
    });

    it('can still manage non-admin users, assigning only roles it fully holds', async () => {
      const rep = await createUser(prisma, orgA);
      await http()
        .post(`${API}/users`)
        .set(as(support))
        .send(createBody({ roleId: supportRoleId }))
        .expect(201);
      await http().post(`${API}/users/${rep.id}/deactivate`).set(as(support)).expect(200);
    });

    it('cannot assign a role with permissions it lacks, on create or update, to self or others', async () => {
      const rep = await createUser(prisma, orgA);
      const richRole = roles[ROLE_NAMES.SALES_REP]; // CRM permissions the support role does not hold

      const created = await http()
        .post(`${API}/users`)
        .set(as(support))
        .send(createBody({ roleId: richRole }))
        .expect(403);
      expect(created.body.code).toBe('CANNOT_GRANT_PERMISSION');

      const toOther = await http()
        .patch(`${API}/users/${rep.id}`)
        .set(as(support))
        .send({ roleId: roles[ROLE_NAMES.SALES_MANAGER] })
        .expect(403);
      expect(toOther.body.code).toBe('CANNOT_GRANT_PERMISSION');

      await http()
        .patch(`${API}/users/${supportUser.id}`)
        .set(as(support))
        .send({ roleId: richRole })
        .expect(403);
      expect((await row(rep.id)).roleId).toBe(roles[ROLE_NAMES.SALES_REP]);
      expect((await row(supportUser.id)).roleId).toBe(supportRoleId);
    });
  });

  describe('tenant isolation', () => {
    it("organization A cannot read, change, deactivate or reset organization B's users", async () => {
      const victim = await createUser(prisma, orgB, { email: 'victim@orgb.test' });
      const before = await row(victim.id);

      const responses = await Promise.all([
        http().get(`${API}/users/${victim.id}`).set(as(admin)),
        http().patch(`${API}/users/${victim.id}`).set(as(admin)).send({ firstName: 'Pwn' }),
        http().post(`${API}/users/${victim.id}/deactivate`).set(as(admin)),
        http().post(`${API}/users/${victim.id}/reactivate`).set(as(admin)),
        http()
          .post(`${API}/users/${victim.id}/reset-password`)
          .set(as(admin))
          .send({ temporaryPassword: TEMP_PASSWORD }),
      ]);
      for (const res of responses) {
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('RESOURCE_NOT_FOUND');
      }

      const after = await row(victim.id);
      expect(after).toEqual(before);
      await http().post(`${API}/auth/login`).send(creds(victim)).expect(200);
    });

    it("never lists organization B's users and cannot filter into them", async () => {
      await createUser(prisma, orgB, { email: 'victim@orgb.test' });
      const list = await http().get(`${API}/users?search=victim`).set(as(admin)).expect(200);
      expect(list.body.data).toEqual([]);
      const byManager = await http()
        .get(`${API}/users?managerId=${orgB.admin.id}`)
        .set(as(admin))
        .expect(200);
      expect(byManager.body.data).toEqual([]);
    });
  });
});
