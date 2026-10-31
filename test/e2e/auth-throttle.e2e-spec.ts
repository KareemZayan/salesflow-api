import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ERROR_CODES } from '../../src/common/constants/error-codes';
import { createTestApp } from '../setup/create-test-app';

const LIMIT = 3;

// The only suite where throttling is on: the shared e2e config sets the limits sky-high.
describe('Auth throttling (e2e)', () => {
  let app: INestApplication;

  // TRUST_PROXY=1 makes req.ip follow X-Forwarded-For, which lets each test play a different client.
  const attempt = (clientIp: string, body: unknown) =>
    request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', clientIp)
      .send(body as object);
  const wrongLogin = (clientIp: string, email = 'nobody@example.com') =>
    attempt(clientIp, { email, password: 'whatever-password' });

  beforeAll(async () => {
    process.env.THROTTLE_AUTH_LIMIT = String(LIMIT);
    process.env.TRUST_PROXY = '1';
    app = await createTestApp();
  });

  afterAll(() => app.close());

  it('answers 429 once the same IP + email exceeds the limit', async () => {
    for (let i = 0; i < LIMIT; i++) await wrongLogin('10.0.0.1').expect(401);

    const res = await wrongLogin('10.0.0.1').expect(429);

    expect(res.body).toMatchObject({ statusCode: 429, code: ERROR_CODES.TOO_MANY_REQUESTS });
    // The named `auth` throttler suffixes its headers with the throttler name.
    expect(res.headers['retry-after-auth']).toBeDefined();
  });

  it('counts per email: other accounts from the same IP are not blocked', async () => {
    for (let i = 0; i < LIMIT; i++) await wrongLogin('10.0.0.2', 'victim@example.com').expect(401);
    await wrongLogin('10.0.0.2', 'victim@example.com').expect(429);

    await wrongLogin('10.0.0.2', 'someone-else@example.com').expect(401);
  });

  it('counts per client IP when TRUST_PROXY is set: the same email from elsewhere is not blocked', async () => {
    for (let i = 0; i < LIMIT; i++) await wrongLogin('10.0.0.3', 'shared@example.com').expect(401);
    await wrongLogin('10.0.0.3', 'shared@example.com').expect(429);

    await wrongLogin('10.0.0.4', 'shared@example.com').expect(401);
  });

  it('treats email case and whitespace as the same account', async () => {
    for (let i = 0; i < LIMIT; i++) await wrongLogin('10.0.0.5', 'Case@Example.com').expect(401);

    await wrongLogin('10.0.0.5', '  case@example.COM ').expect(429);
  });

  it.each([
    ['a number', 123],
    ['an object', { $ne: null }],
    ['an array', ['a@b.co']],
    ['null', null],
  ])('does not crash on %s as email: validation answers 400', async (_label, email) => {
    const res = await attempt('10.0.0.6', { email, password: 'whatever-password' });
    expect([400, 429]).toContain(res.status);
    if (res.status === 400) expect(res.body.code).toBe(ERROR_CODES.VALIDATION_FAILED);
  });

  it('does not throttle health probes', async () => {
    for (let i = 0; i < LIMIT + 3; i++) {
      await request(app.getHttpServer())
        .get('/health')
        .set('X-Forwarded-For', '10.0.0.7')
        .expect(200);
    }
  });
});
