import { randomUUID } from 'node:crypto';
import { INestApplication, Logger } from '@nestjs/common';
import request from 'supertest';
import { ERROR_CODES } from '../../src/common/constants/error-codes';
import { QUEUE_NAME_LIST } from '../../src/infrastructure/queue/queue.constants';
import { RedisThrottlerStorage } from '../../src/infrastructure/throttler/redis-throttler.storage';
import { REDIS_THROTTLER_STORAGE } from '../../src/infrastructure/throttler/throttler-storage.module';
import { createTestApp } from '../setup/create-test-app';
import { deleteKeysWithPrefix, scanKeys, testRedis } from '../support/redis-keys';
import { startStallableProxy, type StallableProxy } from '../support/stallable-proxy';

// Phase 15c over real HTTP: the rate limiter on Redis, shared by instances, and what a client sees
// when Redis is down or slow. THROTTLE_STORAGE=redis here; every other suite runs in memory.
const API = '/api/v1';
const AUTH_LIMIT = 3;
const DEFAULT_LIMIT = 3;
const ENV_KEYS = ['THROTTLE_AUTH_LIMIT', 'THROTTLE_LIMIT', 'TRUST_PROXY'] as const;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Throttle storage on Redis (e2e)', () => {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const admin = testRedis();
  const prefixes: string[] = [];
  const apps: INestApplication[] = [];
  let proxy: StallableProxy | undefined;

  const prefix = () => {
    const value = `thr-e2e-${randomUUID().slice(0, 8)}`;
    prefixes.push(value);
    return value;
  };
  const start = async (options: Parameters<typeof createTestApp>[0]) => {
    const app = await createTestApp(options);
    apps.push(app);
    return app;
  };
  // TRUST_PROXY=1 makes req.ip follow X-Forwarded-For, which lets each case play a different client.
  const login = (app: INestApplication, ip: string, email = 'nobody@example.com') =>
    request(app.getHttpServer())
      .post(`${API}/auth/login`)
      .set('X-Forwarded-For', ip)
      .send({ email, password: 'whatever-password' });
  const storageOf = (app: INestApplication) =>
    app.get<RedisThrottlerStorage>(REDIS_THROTTLER_STORAGE, { strict: false });
  const readiness = async (app: INestApplication) =>
    request(app.getHttpServer()).get('/health/ready');

  beforeAll(() => {
    process.env.THROTTLE_AUTH_LIMIT = String(AUTH_LIMIT);
    process.env.THROTTLE_LIMIT = String(DEFAULT_LIMIT);
    process.env.TRUST_PROXY = '1';
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    for (const app of apps) await app.close();
    await proxy?.close();
    for (const used of prefixes) await deleteKeysWithPrefix(admin, `${used}:`);
    admin.disconnect();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  describe('counters are shared between instances', () => {
    it('attempts split across two apps on one Redis add up to one limit', async () => {
      const shared = prefix();
      const first = await start({ throttle: { prefix: shared } });
      const second = await start({ throttle: { prefix: shared } });

      await login(first, '10.1.0.1').expect(401);
      await login(second, '10.1.0.1').expect(401);
      await login(first, '10.1.0.1').expect(401);
      const res = await login(second, '10.1.0.1').expect(429);

      expect(res.body).toMatchObject({ statusCode: 429, code: ERROR_CODES.TOO_MANY_REQUESTS });
      expect(res.headers['retry-after-auth']).toBeDefined();
      // Neither instance fell back to a limiter of its own.
      expect(storageOf(first).getStats()).toMatchObject({
        servedByFallback: 0,
        rejectedUnavailable: 0,
      });
      expect(storageOf(second).getStats()).toMatchObject({
        servedByFallback: 0,
        rejectedUnavailable: 0,
      });
    });

    it('a different client is not affected by the limit another one used up', async () => {
      const shared = prefix();
      const first = await start({ throttle: { prefix: shared } });
      const second = await start({ throttle: { prefix: shared } });
      for (let i = 0; i < AUTH_LIMIT; i++) await login(first, '10.1.1.1').expect(401);
      await login(second, '10.1.1.1').expect(429);

      await login(second, '10.1.1.2').expect(401);
    });
  });

  describe('what is stored in Redis', () => {
    it('no email address and no IP appear in any key or member, and every key expires', async () => {
      const own = prefix();
      const app = await start({ throttle: { prefix: own } });
      const email = 'victim.person@example.com';
      const ip = '203.0.113.77';
      await login(app, ip, email).expect(401);
      await request(app.getHttpServer())
        .get(`${API}/auth/me`)
        .set('X-Forwarded-For', ip)
        .expect(401);

      const keys = await scanKeys(admin, `${own}:*`);
      const text: string[] = [...keys];
      for (const key of keys) {
        if ((await admin.type(key)) === 'zset') text.push(...(await admin.zrange(key, 0, -1)));
        if ((await admin.type(key)) === 'string') text.push((await admin.get(key)) ?? '');
      }

      // The queues keep their own `<queue>:meta` keys under the same prefix; they are not ours.
      const throttleKeys = keys.filter((key) => key.startsWith(`${own}:throttle:`));
      for (const key of keys.filter((k) => !throttleKeys.includes(k))) {
        expect(QUEUE_NAME_LIST.some((queue) => key.startsWith(`${own}:${queue}:`))).toBe(true);
      }
      expect(throttleKeys.length).toBeGreaterThanOrEqual(4);
      for (const key of throttleKeys) expect(await admin.pttl(key)).toBeGreaterThan(0);
      const everything = text.join('\n').toLowerCase();
      for (const secret of ['victim', 'person', 'example.com', '203.0.113', '203-0-113', '.77']) {
        expect(everything).not.toContain(secret);
      }
      expect(Buffer.from(everything).toString('base64')).not.toContain(
        Buffer.from(email).toString('base64'),
      );
    });
  });

  describe('Redis is down (nothing listens on the port)', () => {
    let app: INestApplication;
    beforeAll(async () => {
      app = await start({ throttle: { redisPort: 1 } });
    });

    it.each([
      [
        'login',
        () =>
          request(app.getHttpServer())
            .post(`${API}/auth/login`)
            .send({ email: 'a@b.co', password: 'x' }),
      ],
      [
        'refresh',
        () => request(app.getHttpServer()).post(`${API}/auth/refresh`).send({ refreshToken: 'x' }),
      ],
    ])(
      '%s fails CLOSED: 503 THROTTLE_UNAVAILABLE, before any password is looked at',
      async (_label, send) => {
        const res = await send();

        expect(res.status).toBe(503);
        expect(res.headers['retry-after']).toBe('5');
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.body).toMatchObject({
          statusCode: 503,
          error: 'Service Unavailable',
          code: ERROR_CODES.THROTTLE_UNAVAILABLE,
          message: 'Request limiting is temporarily unavailable, please retry shortly',
          path: expect.stringContaining(`${API}/auth/`),
        });
        expect(typeof res.body.requestId).toBe('string');
        expect(Number.isNaN(Date.parse(res.body.timestamp))).toBe(false);
        // Not the database error code, and nothing about Redis in the body.
        expect(res.body.code).not.toBe(ERROR_CODES.DATABASE_UNAVAILABLE);
        expect(JSON.stringify(res.body)).not.toMatch(/redis|6379|ECONN|localhost|127\.0\.0\.1/i);
      },
    );

    it('the other routes are NOT unlimited: the per-instance limiter takes over and blocks at the limit', async () => {
      const results: number[] = [];
      for (let i = 0; i < DEFAULT_LIMIT + 2; i++) {
        results.push(
          (
            await request(app.getHttpServer())
              .get(`${API}/auth/me`)
              .set('X-Forwarded-For', '10.2.0.1')
          ).status,
        );
      }

      expect(results).toEqual([401, 401, 401, 429, 429]);
    });

    it('counts the requests it refused', async () => {
      const before = storageOf(app).getStats().rejectedUnavailable;

      await request(app.getHttpServer())
        .post(`${API}/auth/login`)
        .send({ email: 'a@b.co', password: 'x' })
        .expect(503);

      expect(storageOf(app).getStats().rejectedUnavailable).toBe(before + 1);
    });

    it('/health/ready reports the throttle storage as down', async () => {
      const res = await readiness(app);

      expect(res.status).toBe(503);
      expect(res.body.details.throttle).toMatchObject({ status: 'down', storage: 'redis' });
    });
  });

  describe('Redis is slow (answers nothing), then recovers', () => {
    it('opens the breaker so auth fails fast, and closes it again on its own', async () => {
      proxy = await startStallableProxy(Number(process.env.TEST_REDIS_PORT));
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const app = await start({ throttle: { redisPort: proxy.port, prefix: prefix() } });
      const timed = async (n: number) => {
        const startedAt = Date.now();
        const res = await login(app, '10.3.0.1', `slow-${n}@example.com`);
        return { status: res.status, ms: Date.now() - startedAt, code: res.body.code };
      };
      await login(app, '10.3.0.1').expect(401);
      expect(readiness).toBeDefined();

      proxy.stall();
      const during = [];
      for (let n = 0; n < 6; n++) during.push(await timed(n));

      // The first requests each wait for the 250 ms timeout; once 3 have failed, the breaker is open.
      expect(
        during.every((r) => r.status === 503 && r.code === ERROR_CODES.THROTTLE_UNAVAILABLE),
      ).toBe(true);
      for (const r of during.slice(0, 3)) expect(r.ms).toBeGreaterThanOrEqual(200);
      for (const r of during.slice(3)) expect(r.ms).toBeLessThan(150);
      expect(storageOf(app).getStats().state).toBe('open');
      const ready = await readiness(app);
      expect(ready.body.details.throttle).toMatchObject({ status: 'down' });
      expect(
        warn.mock.calls.filter(([m]) => /Throttle storage unavailable/.test(String(m))),
      ).toHaveLength(1);
      expect(storageOf(app).getStats().rejectedUnavailable).toBe(6);

      proxy.resume();
      // Nobody restarts anything: after the open window, one request probes Redis and closes it.
      let recovered = false;
      const recoverBy = Date.now() + 15_000;
      while (!recovered && Date.now() < recoverBy) {
        await sleep(500);
        recovered = (await timed(99)).status === 401;
      }

      expect(recovered).toBe(true);
      expect(storageOf(app).getStats()).toMatchObject({ state: 'closed', rejectedDuringOutage: 0 });
      expect(
        log.mock.calls.filter(([m]) => /Throttle storage available again/.test(String(m))),
      ).toHaveLength(1);
      expect(
        warn.mock.calls.filter(([m]) => /Throttle storage unavailable/.test(String(m))),
      ).toHaveLength(1);
      expect((await readiness(app)).body.details.throttle).toMatchObject({ status: 'up' });
    }, 45_000);
  });
});
