import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { parseCreateOrgArgs } from '../../prisma/seed/create-org-args';
import { createOrganization as runOrgCreate } from '../../prisma/seed/create-org-command';
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
const URL = `${API}/organizations/current`;

interface Tokens {
  accessToken: string;
}

describe('Organizations (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let orgA: TestOrganization;
  let orgB: TestOrganization;
  let admin: Tokens;

  const http = () => request(app.getHttpServer());
  const signIn = async ({ email, password }: Pick<TestUser, 'email' | 'password'>) =>
    (await http().post(`${API}/auth/login`).send({ email, password }).expect(200))
      .body as Tokens & { mustChangePassword: boolean };
  const as = (tokens: Tokens) => ({ Authorization: `Bearer ${tokens.accessToken}` });
  const patch = (tokens: Tokens, body: object) => http().patch(URL).set(as(tokens)).send(body);
  const orgRow = (id: string) => prisma.organization.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    app = await createTestApp();
    prisma = createTestPrisma();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    orgA = await createOrganization(prisma, 'orga');
    orgB = await createOrganization(prisma, 'orgb');
    admin = await signIn(orgA.admin);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('GET /organizations/current', () => {
    it('requires authentication', async () => {
      await http().get(URL).expect(401);
    });

    it('is open to any authenticated user and returns only their own organization', async () => {
      const rep = await signIn(await createUser(prisma, orgA, { role: ROLE_NAMES.SALES_REP }));
      for (const tokens of [admin, rep]) {
        const res = await http().get(URL).set(as(tokens)).expect(200);
        expect(res.body).toMatchObject({
          id: orgA.id,
          slug: 'orga',
          defaultCurrency: 'USD',
          isActive: true,
        });
      }
      const adminB = await signIn(orgB.admin); // sign in first: a request binds to its server on creation
      const resB = await http().get(URL).set(as(adminB)).expect(200);
      expect(resB.body.id).toBe(orgB.id);
    });

    it('answers 403 PASSWORD_CHANGE_REQUIRED while the password change is pending', async () => {
      const locked = await createUser(prisma, orgA, { mustChangePassword: true });
      const lockedTokens = await signIn(locked);
      const res = await http().get(URL).set(as(lockedTokens)).expect(403);
      expect(res.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
    });
  });

  describe('PATCH /organizations/current', () => {
    it('updates name and default currency (trimmed, uppercased)', async () => {
      const res = await patch(admin, { name: '  Acme Corp  ', defaultCurrency: 'egp' }).expect(200);
      expect(res.body).toMatchObject({ name: 'Acme Corp', defaultCurrency: 'EGP', slug: 'orga' });
      expect(await orgRow(orgA.id)).toMatchObject({ name: 'Acme Corp', defaultCurrency: 'EGP' });
    });

    it('accepts a single field', async () => {
      await patch(admin, { defaultCurrency: 'EUR' }).expect(200);
      expect((await orgRow(orgA.id)).name).toBe('orga');
    });

    it('rejects an empty body, null values, blank and oversized names, and bad currencies (400)', async () => {
      await patch(admin, {}).expect(400);
      await patch(admin, { name: null }).expect(400);
      await patch(admin, { defaultCurrency: null }).expect(400);
      await patch(admin, { name: '   ' }).expect(400);
      await patch(admin, { name: 'x'.repeat(101) }).expect(400);
      for (const defaultCurrency of ['XXX1', 'usd1', 'US', 'ZZZ', 12]) {
        await patch(admin, { defaultCurrency }).expect(400);
      }
      expect((await orgRow(orgA.id)).name).toBe('orga');
    });

    it.each([
      ['id', 'ffffffff-ffff-4fff-8fff-ffffffffffff'],
      ['organizationId', 'ffffffff-ffff-4fff-8fff-ffffffffffff'],
      ['slug', 'hijacked'],
      ['isActive', false],
    ])('rejects %s in the body (400) and changes nothing', async (field, value) => {
      const before = await orgRow(orgA.id);
      await patch(admin, { name: 'Renamed', [field]: value }).expect(400);
      expect(await orgRow(orgA.id)).toEqual(before);
    });

    it("organization A's admin cannot change organization B", async () => {
      const beforeB = await orgRow(orgB.id);

      // Aiming at B by id is rejected outright...
      await patch(admin, { id: orgB.id, name: 'Pwned' }).expect(400);
      await patch(admin, { organizationId: orgB.id, name: 'Pwned' }).expect(400);
      // ...there is no :id route to try...
      await http()
        .patch(`${URL.replace('current', orgB.id)}`)
        .set(as(admin))
        .send({ name: 'x' })
        .expect(404);
      // ...and a legitimate update only ever lands on A.
      await patch(admin, { name: 'Only A', defaultCurrency: 'EUR' }).expect(200);

      expect(await orgRow(orgB.id)).toEqual(beforeB);
      expect(await orgRow(orgA.id)).toMatchObject({ name: 'Only A', defaultCurrency: 'EUR' });
    });

    it('requires the organizations:update permission', async () => {
      const without = await signIn(
        await createUser(prisma, orgA, { role: ROLE_NAMES.SALES_MANAGER }),
      );
      const rep = await signIn(await createUser(prisma, orgA, { role: ROLE_NAMES.SALES_REP }));
      for (const tokens of [without, rep]) {
        const res = await patch(tokens, { name: 'Nope' }).expect(403);
        expect(res.body.code).toBe('FORBIDDEN');
      }
      await http().patch(URL).send({ name: 'Nope' }).expect(401);
      expect((await orgRow(orgA.id)).name).toBe('orga');
    });

    it('a custom role holding organizations:update can edit', async () => {
      const role = await createCustomRole(prisma, orgA, 'Settings', ['organizations:update']);
      const editor = await signIn(await createUser(prisma, orgA, { role: role.name }));
      await patch(editor, { name: 'By Editor' }).expect(200);
      expect((await orgRow(orgA.id)).name).toBe('By Editor');
    });
  });

  describe('first admin created by org:create', () => {
    it('must change the password before using the API, then works normally', async () => {
      const result = await runOrgCreate(
        prisma,
        parseCreateOrgArgs(
          ['--name', 'Fresh', '--slug', 'fresh', '--admin-email', 'boss@fresh.test'],
          {},
        ),
      );
      if (result.status !== 'created') throw new Error('expected created');
      const generated = result.generatedPassword as string;

      const login = await signIn({ email: 'boss@fresh.test', password: generated });
      expect(login.mustChangePassword).toBe(true);
      const locked = await http().get(URL).set(as(login)).expect(403);
      expect(locked.body.code).toBe('PASSWORD_CHANGE_REQUIRED');

      const changed = await http()
        .post(`${API}/auth/change-password`)
        .set(as(login))
        .send({ currentPassword: generated, newPassword: TEST_PASSWORD })
        .expect(200);
      const res = await http().get(URL).set(as(changed.body)).expect(200);
      expect(res.body).toMatchObject({ slug: 'fresh', name: 'Fresh' });
    });
  });
});
