import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '../../prisma/seed/prisma-client';
import { PERMISSIONS, ROLE_NAMES } from '../../prisma/seed/permissions';
import { createTestPrisma, resetDatabase } from '../factories/database';
import {
  createCustomRole,
  createOrganization,
  createUser,
  type TestOrganization,
  type TestUser,
} from '../factories/organization.factory';
import { createTestApp } from '../setup/create-test-app';

const API = '/api/v1';

interface Tokens {
  accessToken: string;
}

describe('Roles (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let orgA: TestOrganization;
  let orgB: TestOrganization;
  let admin: Tokens;
  let rolesA: Record<string, string>;
  let rolesB: Record<string, string>;

  const http = () => request(app.getHttpServer());
  const creds = ({ email, password }: Pick<TestUser, 'email' | 'password'>) => ({
    email,
    password,
  });
  const signIn = async (user: TestUser): Promise<Tokens> =>
    (await http().post(`${API}/auth/login`).send(creds(user)).expect(200)).body;
  const as = (tokens: Tokens) => ({ Authorization: `Bearer ${tokens.accessToken}` });
  const roleIds = async (organizationId: string): Promise<Record<string, string>> =>
    Object.fromEntries(
      (await prisma.role.findMany({ where: { organizationId } })).map((r) => [r.name, r.id]),
    );
  const keysOf = async (roleId: string): Promise<string[]> =>
    (await prisma.rolePermission.findMany({ where: { roleId }, include: { permission: true } }))
      .map((rp) => rp.permission.key)
      .sort();
  const createRole = (tokens: Tokens, body: object) =>
    http().post(`${API}/roles`).set(as(tokens)).send(body);

  beforeAll(async () => {
    app = await createTestApp();
    prisma = createTestPrisma();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    orgA = await createOrganization(prisma, 'orga');
    orgB = await createOrganization(prisma, 'orgb');
    rolesA = await roleIds(orgA.id);
    rolesB = await roleIds(orgB.id);
    admin = await signIn(orgA.admin);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('authorization', () => {
    it('requires authentication and the roles permissions', async () => {
      await http().get(`${API}/roles`).expect(401);
      const rep = await signIn(await createUser(prisma, orgA, { role: ROLE_NAMES.SALES_REP }));
      const manager = await signIn(
        await createUser(prisma, orgA, { role: ROLE_NAMES.SALES_MANAGER }),
      );
      for (const tokens of [rep, manager]) {
        await http().get(`${API}/roles`).set(as(tokens)).expect(403);
        await http().get(`${API}/permissions`).set(as(tokens)).expect(403);
        await createRole(tokens, { name: 'X', permissionKeys: [] }).expect(403);
      }
    });
  });

  describe('GET /permissions and /roles', () => {
    it('serves the catalogue', async () => {
      const res = await http().get(`${API}/permissions`).set(as(admin)).expect(200);
      expect(res.body).toHaveLength(Object.keys(PERMISSIONS).length);
      expect(res.body).toContainEqual({ key: 'leads:read', description: 'View leads' });
    });

    it('lists roles with permission keys and user counts (inactive users included)', async () => {
      await createUser(prisma, orgA, { role: ROLE_NAMES.SALES_REP });
      await createUser(prisma, orgA, { role: ROLE_NAMES.SALES_REP, isActive: false });

      const res = await http()
        .get(`${API}/roles?sortBy=name&sortOrder=asc`)
        .set(as(admin))
        .expect(200);

      expect(res.body.meta.total).toBe(3);
      const byName = Object.fromEntries(res.body.data.map((r: { name: string }) => [r.name, r]));
      expect(byName.ADMIN).toMatchObject({ isSystem: true, userCount: 1 });
      expect(byName.ADMIN.permissionKeys).toHaveLength(Object.keys(PERMISSIONS).length);
      expect(byName.SALES_REP.userCount).toBe(2);
      expect(res.body.data.map((r: { name: string }) => r.name)).toEqual([
        'ADMIN',
        'SALES_MANAGER',
        'SALES_REP',
      ]);
    });

    it('rejects a sort field outside the whitelist (400)', async () => {
      const res = await http().get(`${API}/roles?sortBy=isSystem`).set(as(admin)).expect(400);
      expect(res.body.code).toBe('INVALID_SORT_FIELD');
    });

    it('answers 404 for an unknown id', async () => {
      await http()
        .get(`${API}/roles/3fa85f64-5717-4562-b3fc-2c963f66afa6`)
        .set(as(admin))
        .expect(404);
    });
  });

  describe('POST /roles', () => {
    it('creates a custom role with its permissions and trims the name', async () => {
      const res = await createRole(admin, {
        name: '  Support  ',
        description: 'Helps users',
        permissionKeys: ['users:read', 'leads:read'],
      }).expect(201);

      expect(res.body).toMatchObject({
        name: 'Support',
        isSystem: false,
        userCount: 0,
        permissionKeys: ['leads:read', 'users:read'],
      });
      expect(await keysOf(res.body.id)).toEqual(['leads:read', 'users:read']);
    });

    it('rejects bad input: duplicates, too many keys, long names, extra fields (400)', async () => {
      await createRole(admin, { name: 'X', permissionKeys: ['users:read', 'users:read'] }).expect(
        400,
      );
      await createRole(admin, {
        name: 'X',
        permissionKeys: Array.from({ length: 101 }, (_, i) => `k${i}:read`),
      }).expect(400);
      await createRole(admin, { name: 'x'.repeat(51), permissionKeys: [] }).expect(400);
      await createRole(admin, { name: '   ', permissionKeys: [] }).expect(400);
      await createRole(admin, { name: 'X' }).expect(400);
      await createRole(admin, { name: 'X', permissionKeys: [], isSystem: true }).expect(400);
      await createRole(admin, { name: 'X', permissionKeys: [], organizationId: orgB.id }).expect(
        400,
      );
    });

    it('rejects unknown permission keys (400 INVALID_PERMISSION)', async () => {
      const res = await createRole(admin, {
        name: 'X',
        permissionKeys: ['users:read', 'bogus:thing'],
      }).expect(400);
      expect(res.body.code).toBe('INVALID_PERMISSION');
    });

    it.each(['admin', 'ADMIN', 'Sales_Rep', 'sales_manager'])(
      'rejects the reserved name "%s"',
      async (name) => {
        const res = await createRole(admin, { name, permissionKeys: [] }).expect(400);
        expect(res.body.code).toBe('ROLE_NAME_RESERVED');
      },
    );

    it('rejects a duplicate name regardless of case (409), but allows it in another organization', async () => {
      await createRole(admin, { name: 'Support', permissionKeys: [] }).expect(201);
      const res = await createRole(admin, { name: 'sUPPORT', permissionKeys: [] }).expect(409);
      expect(res.body.code).toBe('ROLE_NAME_ALREADY_EXISTS');

      const adminB = await signIn(orgB.admin);
      await createRole(adminB, { name: 'Support', permissionKeys: [] }).expect(201);
    });

    it('two concurrent creates with the same name: one 201, one 409', async () => {
      const results = await Promise.all([
        createRole(admin, { name: 'Race', permissionKeys: [] }),
        createRole(admin, { name: 'race', permissionKeys: [] }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    });
  });

  describe('PATCH /roles/:id', () => {
    it('renames and replaces the permission set in full', async () => {
      const role = await createCustomRole(prisma, orgA, 'Support', ['users:read', 'leads:read']);

      const res = await http()
        .patch(`${API}/roles/${role.id}`)
        .set(as(admin))
        .send({ name: 'Helpdesk', permissionKeys: ['deals:read'] })
        .expect(200);

      expect(res.body).toMatchObject({ name: 'Helpdesk', permissionKeys: ['deals:read'] });
      expect(await keysOf(role.id)).toEqual(['deals:read']);
    });

    it('applies permission changes to already signed-in users on their next request', async () => {
      const role = await createCustomRole(prisma, orgA, 'Support', ['leads:read']);
      const user = await createUser(prisma, orgA, { role: role.name });
      const tokens = await signIn(user);
      await http().get(`${API}/__probe/leads-read`).set(as(tokens)).expect(200);

      await http()
        .patch(`${API}/roles/${role.id}`)
        .set(as(admin))
        .send({ permissionKeys: [] })
        .expect(200);

      await http().get(`${API}/__probe/leads-read`).set(as(tokens)).expect(403);
    });

    it('freezes ADMIN, protects system names, but lets other system roles be trimmed', async () => {
      for (const body of [{ permissionKeys: [] }, { name: 'Boss' }, { description: 'x' }]) {
        const res = await http()
          .patch(`${API}/roles/${rolesA[ROLE_NAMES.ADMIN]}`)
          .set(as(admin))
          .send(body)
          .expect(403);
        expect(res.body.code).toBe('SYSTEM_ROLE_IMMUTABLE');
      }
      const rename = await http()
        .patch(`${API}/roles/${rolesA[ROLE_NAMES.SALES_REP]}`)
        .set(as(admin))
        .send({ name: 'Reps' })
        .expect(403);
      expect(rename.body.code).toBe('SYSTEM_ROLE_IMMUTABLE');

      await http()
        .patch(`${API}/roles/${rolesA[ROLE_NAMES.SALES_REP]}`)
        .set(as(admin))
        .send({ permissionKeys: ['leads:read'] })
        .expect(200);
      expect(await keysOf(rolesA[ROLE_NAMES.SALES_REP])).toEqual(['leads:read']);
    });

    it('rejects renaming to a reserved or taken name', async () => {
      const role = await createCustomRole(prisma, orgA, 'Support', []);
      await createCustomRole(prisma, orgA, 'Other', []);
      const patch = (name: string) =>
        http().patch(`${API}/roles/${role.id}`).set(as(admin)).send({ name });
      expect((await patch('admin')).body.code).toBe('ROLE_NAME_RESERVED');
      expect((await patch('OTHER')).status).toBe(409);
      await patch('SUPPORT').expect(200); // same name, different case: still itself
    });
  });

  describe('DELETE /roles/:id', () => {
    it('deletes an unused custom role', async () => {
      const role = await createCustomRole(prisma, orgA, 'Support', ['leads:read']);
      await http().delete(`${API}/roles/${role.id}`).set(as(admin)).expect(204);
      expect(await prisma.role.count({ where: { id: role.id } })).toBe(0);
      expect(await prisma.rolePermission.count({ where: { roleId: role.id } })).toBe(0);
    });

    it('refuses system roles', async () => {
      const res = await http()
        .delete(`${API}/roles/${rolesA[ROLE_NAMES.SALES_REP]}`)
        .set(as(admin))
        .expect(403);
      expect(res.body.code).toBe('SYSTEM_ROLE_IMMUTABLE');
    });

    it('refuses a role held by active users, and by inactive users only', async () => {
      const role = await createCustomRole(prisma, orgA, 'Support', []);
      const user = await createUser(prisma, orgA, { role: role.name });
      const active = await http().delete(`${API}/roles/${role.id}`).set(as(admin)).expect(409);
      expect(active.body.code).toBe('ROLE_IN_USE');

      await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });
      const inactive = await http().delete(`${API}/roles/${role.id}`).set(as(admin)).expect(409);
      expect(inactive.body.code).toBe('ROLE_IN_USE');
      expect(await prisma.role.count({ where: { id: role.id } })).toBe(1);
    });

    it('deleting a role while it is being assigned never leaves a user without a role', async () => {
      const role = await createCustomRole(prisma, orgA, 'Support', []);
      const rep = await createUser(prisma, orgA);

      const [deleted, assigned] = await Promise.all([
        http().delete(`${API}/roles/${role.id}`).set(as(admin)),
        http().patch(`${API}/users/${rep.id}`).set(as(admin)).send({ roleId: role.id }),
      ]);

      // Serialized by the organization lock: either the assignment wins (delete = 409) or the
      // delete wins (assign = 400). Never both succeed.
      expect([deleted.status, assigned.status].sort()).not.toEqual([200, 204]);
      expect([
        [204, 400],
        [409, 200],
      ]).toContainEqual([deleted.status, assigned.status]);
      const user = await prisma.user.findUniqueOrThrow({ where: { id: rep.id } });
      expect(await prisma.role.count({ where: { id: user.roleId } })).toBe(1);
    });
  });

  describe('privilege escalation', () => {
    let helper: Tokens;

    beforeEach(async () => {
      const role = await createCustomRole(prisma, orgA, 'Helper', [
        'roles:read',
        'roles:manage',
        'leads:read',
      ]);
      helper = await signIn(await createUser(prisma, orgA, { role: role.name }));
    });

    it('can grant only permissions it holds', async () => {
      const denied = await createRole(helper, {
        name: 'Sneaky',
        permissionKeys: ['leads:read', 'users:update'],
      }).expect(403);
      expect(denied.body.code).toBe('CANNOT_GRANT_PERMISSION');
      expect(await prisma.role.count({ where: { name: 'Sneaky' } })).toBe(0);

      await createRole(helper, { name: 'Ok', permissionKeys: ['leads:read'] }).expect(201);
    });

    it('cannot edit or delete a role that holds permissions it lacks', async () => {
      const strong = await createCustomRole(prisma, orgA, 'Strong', ['users:update']);
      const patch = await http()
        .patch(`${API}/roles/${strong.id}`)
        .set(as(helper))
        .send({ permissionKeys: ['leads:read'] })
        .expect(403);
      expect(patch.body.code).toBe('CANNOT_GRANT_PERMISSION');
      await http().delete(`${API}/roles/${strong.id}`).set(as(helper)).expect(403);

      const upgrade = await createCustomRole(prisma, orgA, 'Weak', ['leads:read']);
      await http()
        .patch(`${API}/roles/${upgrade.id}`)
        .set(as(helper))
        .send({ permissionKeys: ['leads:read', 'users:update'] })
        .expect(403);
      expect(await keysOf(upgrade.id)).toEqual(['leads:read']);
    });
  });

  describe('tenant isolation', () => {
    it("organization A cannot see, change or delete organization B's roles", async () => {
      const foreign = await createCustomRole(prisma, orgB, 'Secret', ['leads:read']);
      const foreignSystem = rolesB[ROLE_NAMES.SALES_REP];

      const responses = await Promise.all([
        http().get(`${API}/roles/${foreign.id}`).set(as(admin)),
        http().patch(`${API}/roles/${foreign.id}`).set(as(admin)).send({ name: 'Pwned' }),
        http().delete(`${API}/roles/${foreign.id}`).set(as(admin)),
        http().patch(`${API}/roles/${foreignSystem}`).set(as(admin)).send({ permissionKeys: [] }),
      ]);
      for (const res of responses) {
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('RESOURCE_NOT_FOUND');
      }
      expect((await prisma.role.findUniqueOrThrow({ where: { id: foreign.id } })).name).toBe(
        'Secret',
      );
      expect(await keysOf(foreignSystem)).not.toEqual([]);
    });

    it("lists only the caller's roles and counts only their users", async () => {
      await createCustomRole(prisma, orgB, 'Secret', []);
      await createUser(prisma, orgB, { role: ROLE_NAMES.SALES_REP });
      const res = await http().get(`${API}/roles`).set(as(admin)).expect(200);

      expect(res.body.meta.total).toBe(3);
      expect(res.body.data.map((r: { name: string }) => r.name)).not.toContain('Secret');
      const rep = res.body.data.find((r: { name: string }) => r.name === ROLE_NAMES.SALES_REP);
      expect(rep.userCount).toBe(0);
    });
  });
});
