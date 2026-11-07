import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestPrisma, resetDatabase } from '../factories/database';
import { createOrganization, type TestOrganization } from '../factories/organization.factory';
import { createTestApp } from '../setup/create-test-app';

// Phase 15b: everything the API answers under its prefix (tokens, tenant data, and its errors too)
// must not be kept by a browser or a proxy cache. Nothing outside the prefix is touched.
const API = '/api/v1';
const NO_STORE = 'no-store';

describe('Cache-Control (e2e)', () => {
  let app: INestApplication;
  let org: TestOrganization;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
    const prisma = createTestPrisma();
    await resetDatabase(prisma);
    org = await createOrganization(prisma, 'cache-org');
    await prisma.$disconnect();
  });
  afterAll(() => app.close());

  describe('API responses are never cacheable', () => {
    it('the login response that carries the tokens', async () => {
      const res = await http()
        .post(`${API}/auth/login`)
        .send({ email: org.admin.email, password: org.admin.password })
        .expect(200);

      expect(res.body.accessToken).toEqual(expect.any(String));
      expect(res.headers['cache-control']).toBe(NO_STORE);
    });

    it('an authenticated read of tenant data', async () => {
      const { body } = await http()
        .post(`${API}/auth/login`)
        .send({ email: org.admin.email, password: org.admin.password })
        .expect(200);

      const res = await http()
        .get(`${API}/organizations/current`)
        .set('Authorization', `Bearer ${body.accessToken}`)
        .expect(200);

      expect(res.headers['cache-control']).toBe(NO_STORE);
    });

    it.each([
      ['401 (no token)', () => http().get(`${API}/auth/me`), 401],
      ['400 (validation)', () => http().post(`${API}/auth/login`).send({ email: 'x' }), 400],
      ['404 (unknown route under the prefix)', () => http().get(`${API}/no-such-route`), 404],
      [
        '401 (wrong password)',
        () =>
          http()
            .post(`${API}/auth/login`)
            .send({ email: org.admin.email, password: 'nope-nope-nope' }),
        401,
      ],
    ])('an error response: %s', async (_label, send, status) => {
      const res = await send();

      expect(res.status).toBe(status);
      expect(res.headers['cache-control']).toBe(NO_STORE);
    });
  });

  describe('what the API prefix does not own is left alone', () => {
    it.each([
      ['/health', 200],
      ['/health/ready', 503],
      ['/api/docs-json', 200],
      ['/nope', 404],
      // A path that merely starts with the same characters is not under the prefix.
      ['/api/v1x/auth/me', 404],
    ])('%s', async (path, status) => {
      const res = await http().get(path);

      expect(res.status).toBe(status);
      expect(res.headers['cache-control']).not.toBe(NO_STORE);
    });
  });
});
