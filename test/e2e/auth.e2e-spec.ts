import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type { PrismaClient } from '../../prisma/seed/prisma-client';
import { ROLE_NAMES } from '../../prisma/seed/permissions';
import { ERROR_CODES } from '../../src/common/constants/error-codes';
import { JWT_AUDIENCE, JWT_ISSUER } from '../../src/modules/auth/auth.constants';
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
const SECRET = process.env.JWT_ACCESS_SECRET as string;
const GRACE_MS = 10_000;

interface Tokens {
  accessToken: string;
  refreshToken: string;
  mustChangePassword: boolean;
}

describe('Auth (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let orgA: TestOrganization;
  let orgB: TestOrganization;
  let rep: TestUser;

  const http = () => request(app.getHttpServer());
  const login = (user: Pick<TestUser, 'email' | 'password'>) =>
    http().post(`${API}/auth/login`).send({ email: user.email, password: user.password });
  const signIn = async (user: TestUser): Promise<Tokens> => (await login(user).expect(200)).body;
  const bearer = (tokens: Pick<Tokens, 'accessToken'>) => ({
    Authorization: `Bearer ${tokens.accessToken}`,
  });
  const refresh = (refreshToken: string) =>
    http().post(`${API}/auth/refresh`).send({ refreshToken });
  const me = (tokens: Pick<Tokens, 'accessToken'>) =>
    http().get(`${API}/auth/me`).set(bearer(tokens));
  const probe = (path: string, tokens: Pick<Tokens, 'accessToken'>) =>
    http().get(`${API}/__probe/${path}`).set(bearer(tokens));

  beforeAll(async () => {
    app = await createTestApp();
    prisma = createTestPrisma();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    orgA = await createOrganization(prisma, 'org-a');
    orgB = await createOrganization(prisma, 'org-b');
    rep = await createUser(prisma, orgA, { role: ROLE_NAMES.SALES_REP });
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('POST /auth/login', () => {
    it('returns a token pair, with the mustChangePassword flag', async () => {
      const res = await login(rep).expect(200);

      expect(res.body).toMatchObject({
        tokenType: 'Bearer',
        expiresIn: 900,
        mustChangePassword: false,
      });
      expect(res.body.accessToken.split('.')).toHaveLength(3);
      expect(res.body.refreshToken).toEqual(expect.any(String));
      expect(JSON.stringify(res.body)).not.toContain('passwordHash');
      const user = await prisma.user.findUniqueOrThrow({ where: { id: rep.id } });
      expect(user.lastLoginAt).not.toBeNull();
    });

    it('is case-insensitive on the email', async () => {
      await login({ email: `  ${rep.email.toUpperCase()} `, password: rep.password }).expect(200);
    });

    it('stores only the hash of the refresh token', async () => {
      const { refreshToken } = await signIn(rep);
      const rows = await prisma.refreshToken.findMany({ where: { userId: rep.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0].tokenHash).not.toBe(refreshToken);
      expect(JSON.stringify(rows[0])).not.toContain(refreshToken);
    });

    it('reports mustChangePassword for an admin-provisioned account', async () => {
      const temp = await createUser(prisma, orgA, { mustChangePassword: true });
      expect((await signIn(temp)).mustChangePassword).toBe(true);
    });

    it.each([
      ['a wrong password', () => ({ email: rep.email, password: 'definitely-not-it' })],
      ['an unknown email', () => ({ email: 'nobody@org-a.test', password: TEST_PASSWORD })],
    ])('answers 401 INVALID_CREDENTIALS for %s', async (_label, credentials) => {
      const res = await login(credentials()).expect(401);
      expect(res.body).toMatchObject({ code: ERROR_CODES.INVALID_CREDENTIALS });
    });

    it('answers exactly like a wrong password for inactive users and organizations', async () => {
      const inactive = await createUser(prisma, orgA, { isActive: false });
      await prisma.organization.update({ where: { id: orgB.id }, data: { isActive: false } });

      for (const user of [inactive, orgB.admin]) {
        const res = await login(user).expect(401);
        expect(res.body).toMatchObject({ code: ERROR_CODES.INVALID_CREDENTIALS });
        expect(res.body.message).toBe('Invalid email or password');
      }
    });

    it.each([
      ['missing fields', {}],
      ['a non-string email', { email: 123, password: 'x' }],
      ['an object email', { email: { $ne: null }, password: 'x' }],
      ['an invalid email', { email: 'not-an-email', password: 'x' }],
      ['an oversized password', { email: 'a@b.co', password: 'x'.repeat(129) }],
      ['unknown properties', { email: 'a@b.co', password: 'x', admin: true }],
    ])('answers 400 VALIDATION_FAILED for %s', async (_label, body) => {
      const res = await http().post(`${API}/auth/login`).send(body).expect(400);
      expect(res.body.code).toBe(ERROR_CODES.VALIDATION_FAILED);
    });
  });

  describe('GET /auth/me', () => {
    it('returns the profile with role and permissions', async () => {
      const res = await me(await signIn(rep)).expect(200);

      expect(res.body).toMatchObject({
        id: rep.id,
        organizationId: orgA.id,
        email: rep.email,
        role: 'SALES_REP',
        mustChangePassword: false,
      });
      expect(res.body.permissions).toEqual(expect.arrayContaining(['leads:read', 'deals:update']));
      expect(res.body.permissions).not.toContain('users:create');
      expect(res.body).not.toHaveProperty('passwordHash');
    });

    it('shows each caller only their own organization', async () => {
      const [a, b] = await Promise.all([signIn(orgA.admin), signIn(orgB.admin)]);

      expect((await me(a)).body.organizationId).toBe(orgA.id);
      expect((await me(b)).body.organizationId).toBe(orgB.id);
    });

    it('answers 401 UNAUTHORIZED without a token or with garbage', async () => {
      const none = await http().get(`${API}/auth/me`).expect(401);
      expect(none.body).toMatchObject({ code: ERROR_CODES.UNAUTHORIZED, statusCode: 401 });
      await me({ accessToken: 'garbage' }).expect(401);
    });
  });

  describe('access token verification', () => {
    const forge = new JwtService();
    const claims = () => ({ sub: rep.id, org: orgA.id });
    const valid = {
      secret: SECRET,
      algorithm: 'HS256',
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    } as const;
    const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

    it('accepts a correctly signed token (control)', async () => {
      const accessToken = forge.sign(claims(), { ...valid, expiresIn: 60 });
      await me({ accessToken }).expect(200);
    });

    it('rejects an unsigned alg:none token', async () => {
      const header = b64({ alg: 'none', typ: 'JWT' });
      const payload = b64({ ...claims(), iss: JWT_ISSUER, aud: JWT_AUDIENCE, exp: 4_102_444_800 });
      await me({ accessToken: `${header}.${payload}.` }).expect(401);
    });

    it('rejects a token signed with the wrong secret', async () => {
      const accessToken = forge.sign(claims(), { ...valid, secret: 'w'.repeat(48), expiresIn: 60 });
      await me({ accessToken }).expect(401);
    });

    it('rejects a token signed with another algorithm, even with the right secret', async () => {
      const accessToken = forge.sign(claims(), { ...valid, algorithm: 'HS384', expiresIn: 60 });
      await me({ accessToken }).expect(401);
    });

    it('rejects a wrong issuer or audience', async () => {
      await me({
        accessToken: forge.sign(claims(), { ...valid, issuer: 'someone-else', expiresIn: 60 }),
      }).expect(401);
      await me({
        accessToken: forge.sign(claims(), { ...valid, audience: 'someone-else', expiresIn: 60 }),
      }).expect(401);
    });

    it('answers 401 TOKEN_EXPIRED for an expired token', async () => {
      const accessToken = forge.sign(claims(), { ...valid, expiresIn: -10 });
      const res = await me({ accessToken }).expect(401);
      expect(res.body.code).toBe(ERROR_CODES.TOKEN_EXPIRED);
    });

    it('rejects a token whose organization claim does not match the user', async () => {
      const accessToken = forge.sign({ sub: rep.id, org: orgB.id }, { ...valid, expiresIn: 60 });
      await me({ accessToken }).expect(401);
    });
  });

  describe('immediate effect of account and permission changes', () => {
    it('stops a still-valid access token the moment the user is deactivated', async () => {
      const tokens = await signIn(rep);
      await me(tokens).expect(200);

      await prisma.user.update({ where: { id: rep.id }, data: { isActive: false } });

      await me(tokens).expect(401);
    });

    it('stops a still-valid access token when the organization is deactivated', async () => {
      const tokens = await signIn(rep);
      await prisma.organization.update({ where: { id: orgA.id }, data: { isActive: false } });

      await me(tokens).expect(401);
    });

    it('applies a permission change to a still-valid access token', async () => {
      const tokens = await signIn(rep);
      await probe('leads-read', tokens).expect(200);

      const role = await prisma.role.findUniqueOrThrow({
        where: { organizationId_name: { organizationId: orgA.id, name: 'SALES_REP' } },
      });
      const permission = await prisma.permission.findUniqueOrThrow({
        where: { key: 'leads:read' },
      });
      await prisma.rolePermission.delete({
        where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
      });

      const res = await probe('leads-read', tokens).expect(403);
      expect(res.body.code).toBe(ERROR_CODES.FORBIDDEN);
      expect((await me(tokens)).body.permissions).not.toContain('leads:read');
    });

    it('applies a role change to a still-valid access token', async () => {
      const manager = await createUser(prisma, orgA, { role: ROLE_NAMES.SALES_MANAGER });
      const tokens = await signIn(manager);
      await probe('admin-only', tokens).expect(403);

      const adminRole = await prisma.role.findUniqueOrThrow({
        where: { organizationId_name: { organizationId: orgA.id, name: 'ADMIN' } },
      });
      await prisma.user.update({ where: { id: manager.id }, data: { roleId: adminRole.id } });

      await probe('admin-only', tokens).expect(200);
    });
  });

  describe('guards over HTTP', () => {
    it('answers 401 for unauthenticated calls to protected routes', async () => {
      await http().get(`${API}/__probe/open`).expect(401);
    });

    it('enforces @Roles and @Permissions with 403 FORBIDDEN', async () => {
      const repTokens = await signIn(rep);
      const adminTokens = await signIn(orgA.admin);

      expect((await probe('admin-only', repTokens).expect(403)).body.code).toBe(
        ERROR_CODES.FORBIDDEN,
      );
      await probe('admin-only', adminTokens).expect(200);
      await probe('leads-read', repTokens).expect(200);
    });

    it('takes the tenant from the token, so each caller sees their own organization', async () => {
      expect((await probe('open', await signIn(orgA.admin))).body.organizationId).toBe(orgA.id);
      expect((await probe('open', await signIn(orgB.admin))).body.organizationId).toBe(orgB.id);
    });
  });

  describe('POST /auth/refresh', () => {
    it('rotates: returns a new pair, and the new access token works', async () => {
      const first = await signIn(rep);

      const res = await refresh(first.refreshToken).expect(200);

      expect(res.body.refreshToken).not.toBe(first.refreshToken);
      await me(res.body).expect(200);
      const family = await prisma.refreshToken.findMany({ where: { userId: rep.id } });
      expect(new Set(family.map((token) => token.familyId)).size).toBe(1);
    });

    it('answers 409 TOKEN_ROTATED_RECENTLY (not 401) for a just-rotated token and keeps the session', async () => {
      const first = await signIn(rep);
      const second = (await refresh(first.refreshToken).expect(200)).body as Tokens;

      const res = await refresh(first.refreshToken).expect(409);

      expect(res.body.code).toBe(ERROR_CODES.TOKEN_ROTATED_RECENTLY);
      await refresh(second.refreshToken).expect(200);
    });

    it('treats an old rotated token as theft: revokes the whole family (reuse detection)', async () => {
      const first = await signIn(rep);
      const second = (await refresh(first.refreshToken).expect(200)).body as Tokens;
      // Pretend the rotation happened long ago, i.e. outside the grace window.
      await prisma.refreshToken.updateMany({
        where: { userId: rep.id, revokedAt: { not: null } },
        data: { revokedAt: new Date(Date.now() - 2 * GRACE_MS) },
      });

      const replay = await refresh(first.refreshToken).expect(401);
      expect(replay.body.code).toBe(ERROR_CODES.TOKEN_REUSED);

      // The legitimate holder's newest token died with the family.
      const victim = await refresh(second.refreshToken).expect(401);
      expect(victim.body.code).toBe(ERROR_CODES.INVALID_REFRESH_TOKEN);
      const live = await prisma.refreshToken.count({ where: { userId: rep.id, revokedAt: null } });
      expect(live).toBe(0);
    });

    it('does not report a false TOKEN_REUSED for concurrent refreshes with the same token', async () => {
      const first = await signIn(rep);

      const results = await Promise.all(
        Array.from({ length: 6 }, () => refresh(first.refreshToken)),
      );

      const statuses = results.map((res) => res.status).sort();
      expect(statuses).toEqual([200, 409, 409, 409, 409, 409]);
      const losers = results.filter((res) => res.status === 409);
      expect(losers.every((res) => res.body.code === ERROR_CODES.TOKEN_ROTATED_RECENTLY)).toBe(
        true,
      );
      // Exactly one successor exists and it still works.
      const winner = results.find((res) => res.status === 200)!.body as Tokens;
      expect(await prisma.refreshToken.count({ where: { userId: rep.id, revokedAt: null } })).toBe(
        1,
      );
      await refresh(winner.refreshToken).expect(200);
    });

    it('rejects unknown tokens with 401 INVALID_REFRESH_TOKEN', async () => {
      const res = await refresh('not-a-real-token').expect(401);
      expect(res.body.code).toBe(ERROR_CODES.INVALID_REFRESH_TOKEN);
    });

    it('rejects an expired token', async () => {
      const tokens = await signIn(rep);
      await prisma.refreshToken.updateMany({
        where: { userId: rep.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await refresh(tokens.refreshToken).expect(401);
    });

    it('fails for a user deactivated after login, and kills the session', async () => {
      const tokens = await signIn(rep);
      await prisma.user.update({ where: { id: rep.id }, data: { isActive: false } });

      const res = await refresh(tokens.refreshToken).expect(401);

      expect(res.body.code).toBe(ERROR_CODES.INVALID_REFRESH_TOKEN);
      expect(await prisma.refreshToken.count({ where: { userId: rep.id, revokedAt: null } })).toBe(
        0,
      );
    });

    it('fails when the organization was deactivated after login', async () => {
      const tokens = await signIn(rep);
      await prisma.organization.update({ where: { id: orgA.id }, data: { isActive: false } });

      await refresh(tokens.refreshToken).expect(401);
    });

    it('answers 400 for a missing token', async () => {
      await http().post(`${API}/auth/refresh`).send({}).expect(400);
    });
  });

  describe('POST /auth/logout', () => {
    it('revokes the session and is idempotent', async () => {
      const tokens = await signIn(rep);

      await http()
        .post(`${API}/auth/logout`)
        .send({ refreshToken: tokens.refreshToken })
        .expect(204);
      await http()
        .post(`${API}/auth/logout`)
        .send({ refreshToken: tokens.refreshToken })
        .expect(204);

      const res = await refresh(tokens.refreshToken).expect(401);
      // Just logged out: a 409 "retry with your latest token" would send clients in circles.
      expect(res.body.code).toBe(ERROR_CODES.INVALID_REFRESH_TOKEN);
    });

    it('answers 204 even for an unknown token', async () => {
      await http().post(`${API}/auth/logout`).send({ refreshToken: 'who-knows' }).expect(204);
    });

    it('revokes the whole rotation family, not just the presented token', async () => {
      const first = await signIn(rep);
      const second = (await refresh(first.refreshToken).expect(200)).body as Tokens;

      await http()
        .post(`${API}/auth/logout`)
        .send({ refreshToken: first.refreshToken })
        .expect(204);

      await refresh(second.refreshToken).expect(401);
    });

    it('does not touch other sessions of the same user', async () => {
      const laptop = await signIn(rep);
      const phone = await signIn(rep);

      await http()
        .post(`${API}/auth/logout`)
        .send({ refreshToken: laptop.refreshToken })
        .expect(204);

      await refresh(phone.refreshToken).expect(200);
    });

    it('answers 400 for a missing token', async () => {
      await http().post(`${API}/auth/logout`).send({}).expect(400);
    });
  });

  describe('POST /auth/change-password', () => {
    const change = (tokens: Pick<Tokens, 'accessToken'>, body: object) =>
      http().post(`${API}/auth/change-password`).set(bearer(tokens)).send(body);
    const NEW_PASSWORD = 'a-completely-new-password';

    it('requires authentication', async () => {
      await http().post(`${API}/auth/change-password`).send({}).expect(401);
    });

    it('rejects a wrong current password', async () => {
      const res = await change(await signIn(rep), {
        currentPassword: 'not-my-password',
        newPassword: NEW_PASSWORD,
      }).expect(400);
      expect(res.body.code).toBe(ERROR_CODES.CURRENT_PASSWORD_INCORRECT);
    });

    it('rejects a new password equal to the current one', async () => {
      const res = await change(await signIn(rep), {
        currentPassword: TEST_PASSWORD,
        newPassword: TEST_PASSWORD,
      }).expect(400);
      expect(res.body.code).toBe(ERROR_CODES.WEAK_PASSWORD);
    });

    it.each([
      ['too short', 'short'],
      ['too long', 'x'.repeat(129)],
      ['the seed placeholder', 'change_me_strong_password'],
    ])('rejects a new password that is %s', async (_label, newPassword) => {
      const res = await change(await signIn(rep), {
        currentPassword: TEST_PASSWORD,
        newPassword,
      }).expect(400);
      expect(res.body.code).toBe(ERROR_CODES.WEAK_PASSWORD);
    });

    it('returns a new token pair, revokes every old refresh token and switches the password', async () => {
      const laptop = await signIn(rep);
      const phone = await signIn(rep);

      const res = await change(laptop, {
        currentPassword: TEST_PASSWORD,
        newPassword: NEW_PASSWORD,
      }).expect(200);
      const fresh = res.body as Tokens;

      expect(fresh.refreshToken).not.toBe(laptop.refreshToken);
      expect(fresh.mustChangePassword).toBe(false);
      // Old sessions on every device are gone...
      await refresh(laptop.refreshToken).expect(401);
      await refresh(phone.refreshToken).expect(401);
      // ...the new one works...
      await refresh(fresh.refreshToken).expect(200);
      // ...and so does the new password, but not the old one.
      await login({ email: rep.email, password: NEW_PASSWORD }).expect(200);
      await login(rep).expect(401);
    });

    it('leaves already-issued access tokens valid until they expire (documented behaviour)', async () => {
      const tokens = await signIn(rep);
      await change(tokens, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD }).expect(
        200,
      );

      await me(tokens).expect(200);
    });

    it('lifts the mustChangePassword lock', async () => {
      const temp = await createUser(prisma, orgA, { mustChangePassword: true });
      const tokens = await signIn(temp);

      // Locked: everything except me / change-password answers 403.
      const blocked = await probe('open', tokens).expect(403);
      expect(blocked.body.code).toBe(ERROR_CODES.PASSWORD_CHANGE_REQUIRED);
      expect((await me(tokens).expect(200)).body.mustChangePassword).toBe(true);

      const res = await change(tokens, {
        currentPassword: TEST_PASSWORD,
        newPassword: NEW_PASSWORD,
      }).expect(200);

      expect(res.body.mustChangePassword).toBe(false);
      await probe('open', res.body).expect(200);
      expect((await me(res.body)).body.mustChangePassword).toBe(false);
    });
  });
});
