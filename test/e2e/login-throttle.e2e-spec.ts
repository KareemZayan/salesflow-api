import { randomUUID } from 'node:crypto';
import { INestApplication, Logger } from '@nestjs/common';
import request from 'supertest';
import { ERROR_CODES } from '../../src/common/constants/error-codes';
import { RedisThrottlerStorage } from '../../src/infrastructure/throttler/redis-throttler.storage';
import { REDIS_THROTTLER_STORAGE } from '../../src/infrastructure/throttler/throttler-storage.module';
import { createTestPrisma, resetDatabase } from '../factories/database';
import { createOrganization, type TestOrganization } from '../factories/organization.factory';
import { createTestApp } from '../setup/create-test-app';
import { deleteKeysWithPrefix, scanKeys, testRedis } from '../support/redis-keys';
import { startStallableProxy, type StallableProxy } from '../support/stallable-proxy';

// Phase 15c.1 over real HTTP: the combined login limiter (per IP and per IP + email, one atomic Redis
// operation), IPv6 /64 normalization, and logout staying available while Redis is down.
const API = '/api/v1';
const ACCOUNT_LIMIT = 3;
const IP_LIMIT = 12;
const DEFAULT_LIMIT = 3;
const ENV_KEYS = [
  'THROTTLE_AUTH_LIMIT',
  'THROTTLE_AUTH_IP_LIMIT',
  'THROTTLE_LIMIT',
  'TRUST_PROXY',
] as const;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Login throttling (e2e)', () => {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const admin = testRedis();
  const prefixes: string[] = [];
  const apps: INestApplication[] = [];
  let proxy: StallableProxy | undefined;
  let org: TestOrganization;

  const newPrefix = () => {
    const value = `thr-login-${randomUUID().slice(0, 8)}`;
    prefixes.push(value);
    return value;
  };
  const start = async (options: Parameters<typeof createTestApp>[0]) => {
    const app = await createTestApp(options);
    apps.push(app);
    return app;
  };
  // TRUST_PROXY=1 makes req.ip follow X-Forwarded-For, which lets every case play a different client.
  const login = (app: INestApplication, ip: string, email: string, password = 'wrong-password-1') =>
    request(app.getHttpServer())
      .post(`${API}/auth/login`)
      .set('X-Forwarded-For', ip)
      .send({ email, password });
  const logout = (app: INestApplication, refreshToken: string, ip = '10.9.9.9') =>
    request(app.getHttpServer())
      .post(`${API}/auth/logout`)
      .set('X-Forwarded-For', ip)
      .send({ refreshToken });
  const storageOf = (app: INestApplication) =>
    app.get<RedisThrottlerStorage>(REDIS_THROTTLER_STORAGE, { strict: false });
  // `n` logins, one after the other, each with its own email, from `ip`.
  const spray = async (app: INestApplication, ip: string, n: number, tag = 'spray') => {
    const statuses: number[] = [];
    for (let i = 0; i < n; i++)
      statuses.push((await login(app, ip, `${tag}${i}@example.com`)).status);
    return statuses;
  };
  const count = (statuses: number[], status: number) => statuses.filter((s) => s === status).length;

  beforeAll(async () => {
    process.env.THROTTLE_AUTH_LIMIT = String(ACCOUNT_LIMIT);
    process.env.THROTTLE_AUTH_IP_LIMIT = String(IP_LIMIT);
    process.env.THROTTLE_LIMIT = String(DEFAULT_LIMIT);
    process.env.TRUST_PROXY = '1';
    const prisma = createTestPrisma();
    await resetDatabase(prisma);
    org = await createOrganization(prisma, 'login-throttle');
    await prisma.$disconnect();
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

  describe('one IP, many emails (password spraying)', () => {
    let app: INestApplication;
    let own: string;
    beforeAll(async () => {
      own = newPrefix();
      app = await start({ throttle: { prefix: own } });
    });

    it('is cut off at the IP limit however the emails change, with Retry-After-login', async () => {
      const statuses = await spray(app, '10.20.0.1', IP_LIMIT + 5);

      expect(count(statuses, 401)).toBe(IP_LIMIT);
      expect(count(statuses, 429)).toBe(5);
      const refused = await login(app, '10.20.0.1', 'one-more@example.com').expect(429);
      expect(refused.body).toMatchObject({ statusCode: 429, code: ERROR_CODES.TOO_MANY_REQUESTS });
      expect(refused.headers['retry-after-login']).toBeDefined();
      expect(refused.headers['retry-after-auth']).toBeUndefined(); // the header is named for login now
    });

    it('creates no Redis key once the IP is over its limit: 50 more emails change nothing', async () => {
      const keys = async () => (await scanKeys(admin, `${own}:throttle:login:*`)).sort();
      const before = await keys();
      expect(before.filter((k) => k.includes(':login:ip:'))).toHaveLength(1);
      expect(before.filter((k) => k.includes(':login:account:'))).toHaveLength(IP_LIMIT);

      const statuses = await spray(app, '10.20.0.1', 50, 'flood');

      expect(count(statuses, 429)).toBe(50);
      expect(await keys()).toEqual(before);
    });

    it('rotating the address inside one /64 does not help: it is still one IP', async () => {
      const results: number[] = [];
      for (let i = 0; i < IP_LIMIT + 4; i++) {
        const address = `2001:db8:feed:1::${(i + 1).toString(16)}`;
        results.push((await login(app, address, `rotate${i}@example.com`)).status);
      }

      expect(count(results, 401)).toBe(IP_LIMIT);
      expect(count(results, 429)).toBe(4);
    });

    it('another IP is untouched while the first is cut off', async () => {
      await login(app, '10.20.0.2', 'someone@example.com').expect(401);
    });
  });

  describe('one account, many IPs', () => {
    it('each IP gets its own allowance on the account, so the victim is not locked out from other IPs', async () => {
      const app = await start({ throttle: { prefix: newPrefix() } });
      const victim = 'victim@example.com';

      for (const ip of ['10.30.0.1', '10.30.0.2', '10.30.0.3']) {
        for (let i = 0; i < ACCOUNT_LIMIT; i++) await login(app, ip, victim).expect(401);
        await login(app, ip, victim).expect(429); // this IP is done with this account ...
      }
      // ... and a fresh IP (the real owner, say) is not affected by any of it.
      await login(app, '10.30.0.4', victim).expect(401);
    });

    it('an attacker IP is still bounded overall: the per-IP limit holds across accounts', async () => {
      const app = await start({ throttle: { prefix: newPrefix() } });
      const statuses: number[] = [];
      for (let i = 0; i < IP_LIMIT + 3; i++) {
        statuses.push((await login(app, '10.30.1.1', `target${i % 6}@example.com`)).status);
      }

      // 6 accounts x 3 attempts = 18 would be allowed by the accounts alone; the IP stops it at 12.
      expect(count(statuses, 401)).toBe(IP_LIMIT);
    });
  });

  describe('IPv6 /64 normalization, and IPv4 unchanged', () => {
    let app: INestApplication;
    beforeAll(async () => {
      app = await start({ throttle: { prefix: newPrefix() } });
    });

    it('addresses in the same /64 share the per-account bucket', async () => {
      const email = 'v6-account@example.com';
      await login(app, '2001:db8:aaaa:1::1', email).expect(401);
      await login(app, '2001:db8:aaaa:1:ffff::2', email).expect(401);
      await login(app, '2001:db8:aaaa:1:1234:5678:9abc:def0', email).expect(401);

      await login(app, '2001:db8:aaaa:1::99', email).expect(429);
    });

    it('a different /64 has its own buckets', async () => {
      const email = 'v6-account@example.com';
      await login(app, '2001:db8:aaaa:2::1', email).expect(401);
    });

    it('IPv4 addresses stay separate from one another', async () => {
      const email = 'v4-account@example.com';
      for (let i = 0; i < ACCOUNT_LIMIT; i++) await login(app, '10.40.0.1', email).expect(401);
      await login(app, '10.40.0.1', email).expect(429);

      await login(app, '10.40.0.2', email).expect(401);
    });

    it('an IPv4-mapped IPv6 address is the IPv4 address', async () => {
      const email = 'mapped@example.com';
      await login(app, '10.40.1.1', email).expect(401);
      await login(app, '::ffff:10.40.1.1', email).expect(401);
      await login(app, '10.40.1.1', email).expect(401);

      await login(app, '::ffff:10.40.1.1', email).expect(429);
    });
  });

  describe('a shared address (NAT)', () => {
    it('one account hammered by someone does not use up the budget of everybody else on that address', async () => {
      const own = newPrefix();
      const app = await start({ throttle: { prefix: own } });

      const hammered: number[] = [];
      for (let i = 0; i < 40; i++)
        hammered.push((await login(app, '10.50.0.1', 'noisy@example.com')).status);
      const colleagues = await spray(app, '10.50.0.1', IP_LIMIT, 'colleague');

      expect(count(hammered, 401)).toBe(ACCOUNT_LIMIT);
      expect(count(hammered, 429)).toBe(40 - ACCOUNT_LIMIT);
      // The hammering used up only ACCOUNT_LIMIT of the IP budget, so IP_LIMIT - ACCOUNT_LIMIT remain.
      expect(count(colleagues, 401)).toBe(IP_LIMIT - ACCOUNT_LIMIT);
      expect(count(colleagues, 429)).toBe(ACCOUNT_LIMIT);
    });
  });

  describe('existing sign-in behaviour', () => {
    it('a correct password still signs in, and a wrong one is still 401 INVALID_CREDENTIALS', async () => {
      const app = await start({ throttle: { prefix: newPrefix() } });

      const ok = await login(app, '10.60.0.1', org.admin.email, org.admin.password).expect(200);
      const bad = await login(app, '10.60.0.1', org.admin.email, 'not-the-password-0').expect(401);

      expect(ok.body.accessToken).toEqual(expect.any(String));
      expect(ok.body.refreshToken).toEqual(expect.any(String));
      expect(bad.body.code).toBe(ERROR_CODES.INVALID_CREDENTIALS);
    });

    it('a body whose email is not a string is validated (400) and cannot flood Redis with keys', async () => {
      const own = newPrefix();
      const app = await start({ throttle: { prefix: own } });
      const send = (email: unknown, ip: string) =>
        request(app.getHttpServer())
          .post(`${API}/auth/login`)
          .set('X-Forwarded-For', ip)
          .send({ email, password: 'whatever-password' });
      const statuses: number[] = [];
      for (const email of [42, { $ne: null }, ['a@b.co'], null, 7, false]) {
        statuses.push((await send(email, '10.60.1.1')).status);
      }

      // All of them share the empty-email bucket of that IP: three get a 400, then the account limit.
      expect(statuses.slice(0, ACCOUNT_LIMIT).every((s) => s === 400)).toBe(true);
      expect(statuses.slice(ACCOUNT_LIMIT).every((s) => s === 429)).toBe(true);
      const accountKeys = (await scanKeys(admin, `${own}:throttle:login:account:*`)).length;
      expect(accountKeys).toBe(1);
    });

    it('no address or email is stored in Redis, and every key has a TTL', async () => {
      const own = newPrefix();
      const app = await start({ throttle: { prefix: own } });
      await login(app, '203.0.113.77', 'victim.person@example.com').expect(401);
      await login(app, '2001:db8:beef:7::5', 'other.person@example.com').expect(401);

      const keys = await scanKeys(admin, `${own}:throttle:login:*`);
      const members: string[] = [];
      for (const key of keys) {
        expect(await admin.pttl(key)).toBeGreaterThan(0);
        members.push(...(await admin.zrange(key, 0, -1)));
      }

      expect(keys).toHaveLength(4);
      const everything = [...keys, ...members].join('\n').toLowerCase();
      for (const secret of ['victim', 'other.person', 'example', '203.0.113', 'beef', '@']) {
        expect(everything).not.toContain(secret);
      }
    });
  });

  describe('Redis is down (nothing listens on the port)', () => {
    let app: INestApplication;
    beforeAll(async () => {
      app = await start({ throttle: { redisPort: 1 } });
    });

    it('login fails CLOSED: 503 THROTTLE_UNAVAILABLE with Retry-After, whatever the password', async () => {
      const res = await login(app, '10.70.0.1', org.admin.email, org.admin.password);

      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('5');
      expect(res.body).toMatchObject({ statusCode: 503, code: ERROR_CODES.THROTTLE_UNAVAILABLE });
      expect(res.body.accessToken).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toMatch(/redis|6379|ECONN|localhost/i);
    });

    it('logout still works: 204, never 503', async () => {
      const res = await logout(app, 'a-refresh-token-that-is-not-valid');

      expect(res.status).toBe(204);
    });

    it('logout is still rate limited, by the per-instance limiter (never unlimited)', async () => {
      const results: number[] = [];
      for (let i = 0; i < DEFAULT_LIMIT + 2; i++) {
        results.push((await logout(app, `token-${i}`, '10.70.0.9')).status);
      }

      expect(results).toEqual([204, 204, 204, 429, 429]);
    });

    it('refresh and change-password are unchanged: they still fail closed', async () => {
      await request(app.getHttpServer())
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: 'x' })
        .expect(503);
    });

    it('the refusals are counted', () => {
      expect(storageOf(app).getStats().rejectedUnavailable).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Redis stalls, then recovers', () => {
    it('login fails fast once the breaker is open, logout works throughout and really ends the session', async () => {
      proxy = await startStallableProxy(Number(process.env.TEST_REDIS_PORT));
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const app = await start({ throttle: { redisPort: proxy.port, prefix: newPrefix() } });
      const timed = async (email: string, ip = '10.80.0.1') => {
        const startedAt = Date.now();
        const res = await login(app, ip, email);
        return { status: res.status, ms: Date.now() - startedAt, code: res.body.code };
      };
      // A real session, signed in while Redis is healthy.
      const session = (
        await login(app, '10.80.0.9', org.admin.email, org.admin.password).expect(200)
      ).body as { refreshToken: string };

      proxy.stall();
      const during = [];
      for (let n = 0; n < 6; n++) during.push(await timed(`slow${n}@example.com`));

      // One Redis call per login: the first three wait for the 250 ms timeout, the rest are answered at once.
      expect(
        during.every((r) => r.status === 503 && r.code === ERROR_CODES.THROTTLE_UNAVAILABLE),
      ).toBe(true);
      for (const r of during.slice(0, 3)) expect(r.ms).toBeGreaterThanOrEqual(200);
      for (const r of during.slice(3)) expect(r.ms).toBeLessThan(150);
      expect(storageOf(app).getStats().state).toBe('open');
      expect(
        warn.mock.calls.filter(([m]) => /Throttle storage unavailable/.test(String(m))),
      ).toHaveLength(1);

      // Logout works in the middle of the outage, and quickly.
      const startedAt = Date.now();
      const out = await logout(app, session.refreshToken, '10.80.0.9');
      expect(out.status).toBe(204);
      expect(Date.now() - startedAt).toBeLessThan(1000);

      proxy.resume();
      let recovered = false;
      const recoverBy = Date.now() + 15_000;
      while (!recovered && Date.now() < recoverBy) {
        await sleep(500);
        recovered = (await timed('after@example.com', '10.80.0.5')).status === 401;
      }

      expect(recovered).toBe(true);
      expect(storageOf(app).getStats()).toMatchObject({ state: 'closed', rejectedDuringOutage: 0 });
      expect(
        log.mock.calls.filter(([m]) => /Throttle storage available again/.test(String(m))),
      ).toHaveLength(1);
      // The session really was ended during the outage: its refresh token no longer works.
      const refresh = await request(app.getHttpServer())
        .post(`${API}/auth/refresh`)
        .set('X-Forwarded-For', '10.80.0.9')
        .send({ refreshToken: session.refreshToken });
      expect(refresh.status).toBe(401);
    }, 60_000);
  });
});
