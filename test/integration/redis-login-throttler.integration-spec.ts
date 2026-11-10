import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  FAIL_CLOSED_THROTTLERS,
  LOGIN_THROTTLER,
} from '../../src/common/constants/throttle.constants';
import { ThrottleUnavailableException } from '../../src/common/exceptions/throttle-unavailable.exception';
import { RedisThrottlerStorage } from '../../src/infrastructure/throttler/redis-throttler.storage';
import { createThrottleRedis } from '../../src/infrastructure/throttler/throttle-redis.client';
import { THROTTLE_LOGIN_SCRIPT } from '../../src/infrastructure/throttler/throttle-login.script';
import { deleteKeysWithPrefix, scanKeys, testRedis } from '../support/redis-keys';

// ADR 0016, 15c.1: the COMBINED login limiter against the real compose Redis. The two limits (per IP,
// per IP + email) are decided by one Lua operation, so these tests are about what that buys:
//  - a refused request creates no key (the cardinality of Redis is bounded by the IP limit);
//  - one hammered account does not use up the budget of everybody behind the same address;
//  - the guarantees hold under concurrency, on one connection and on several;
//  - a failure inside the script leaves no counter half-changed.
// Each test owns a random prefix and removes only what is under it.
const TTL = 60_000;
const ACCOUNT_LIMIT = 10;
const IP_LIMIT = 120;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('Redis login limiter (integration, real Redis)', () => {
  const port = Number(process.env.TEST_REDIS_PORT);
  const redisConfig = {
    host: '127.0.0.1',
    port,
    password: process.env.REDIS_PASSWORD || undefined,
  };
  const admin = testRedis();
  const storages: RedisThrottlerStorage[] = [];
  const prefixes: string[] = [];
  let thisTest: RedisThrottlerStorage[] = [];
  let fallbackExpected = false;
  let prefix: string;

  const newStorage = async (options: { ipLimit?: number; prefix?: string } = {}) => {
    const storage = new RedisThrottlerStorage(
      createThrottleRedis(redisConfig, { prefix: options.prefix ?? prefix }),
      {
        failClosedThrottlers: FAIL_CLOSED_THROTTLERS,
        compositeThrottlers: new Map([[LOGIN_THROTTLER, { ipLimit: options.ipLimit ?? IP_LIMIT }]]),
      },
    );
    storages.push(storage);
    thisTest.push(storage);
    // As at application startup: wait for the connection (there is no offline queue).
    await storage.onModuleInit();
    return storage;
  };
  const attempt = (
    storage: RedisThrottlerStorage,
    ip: string,
    email: string,
    accountLimit = ACCOUNT_LIMIT,
  ) => storage.increment(`${ip}|${email}`, TTL, accountLimit, 0, LOGIN_THROTTLER);
  // Runs `count` attempts in parallel, spread over the given storages, and tells how many got in.
  const admittedOf = async (
    attempts: Array<Promise<{ isBlocked: boolean }>>,
  ): Promise<{ admitted: number; blocked: number }> => {
    const results = await Promise.all(attempts);
    const admitted = results.filter((r) => !r.isBlocked).length;
    return { admitted, blocked: results.length - admitted };
  };
  const inBatches = async <T>(items: T[], size: number, run: (item: T) => Promise<unknown>) => {
    for (let i = 0; i < items.length; i += size) {
      await Promise.all(items.slice(i, i + size).map(run));
    }
  };

  const loginKeys = () => scanKeys(admin, `${prefix}:throttle:login:*`);
  const ipKeys = async () => (await loginKeys()).filter((k) => k.includes(':login:ip:'));
  const accountKeys = async () => (await loginKeys()).filter((k) => k.includes(':login:account:'));
  const sorted = async () => (await loginKeys()).sort();

  beforeEach(() => {
    prefix = `thr-login-${randomUUID().slice(0, 8)}`;
    prefixes.push(prefix);
    thisTest = [];
    fallbackExpected = false;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (fallbackExpected) return;
    // Every request must have been decided by Redis: a silent failure would make most checks pass for
    // the wrong reason.
    for (const storage of thisTest) {
      expect(storage.getStats()).toMatchObject({ rejectedUnavailable: 0, servedByFallback: 0 });
    }
  });
  afterAll(async () => {
    for (const storage of storages) storage.onModuleDestroy();
    for (const used of prefixes) await deleteKeysWithPrefix(admin, `${used}:`);
    admin.disconnect();
  });

  describe('key cardinality: a refused request never creates a key', () => {
    it('5,000 different emails from ONE IP: exactly 120 get in, 1 IP key + 120 account keys exist', async () => {
      const storage = await newStorage();
      const emails = Array.from({ length: 5000 }, (_, i) => `user${i}@example.com`);

      let admitted = 0;
      await inBatches(emails, 250, async (email) => {
        if (!(await attempt(storage, '203.0.113.7', email)).isBlocked) admitted += 1;
      });

      expect(admitted).toBe(IP_LIMIT);
      expect(await ipKeys()).toHaveLength(1);
      expect(await accountKeys()).toHaveLength(IP_LIMIT);
      expect(storage.getStats()).toMatchObject({
        blockedByIp: 5000 - IP_LIMIT,
        blockedByAccount: 0,
      });
    }, 60_000);

    it('and 5,000 MORE different emails after that create NO new key at all (the key set is identical)', async () => {
      const storage = await newStorage();
      await inBatches(
        Array.from({ length: 300 }, (_, i) => `first${i}@example.com`),
        100,
        (email) => attempt(storage, '203.0.113.7', email),
      );
      const before = await sorted();
      const ipZset = (await ipKeys())[0];
      const membersBefore = await admin.zrange(ipZset, 0, -1, 'WITHSCORES');
      expect(before).toHaveLength(1 + IP_LIMIT);

      let blocked = 0;
      await inBatches(
        Array.from({ length: 5000 }, (_, i) => `second${i}@example.com`),
        250,
        async (email) => {
          if ((await attempt(storage, '203.0.113.7', email)).isBlocked) blocked += 1;
        },
      );

      expect(blocked).toBe(5000);
      expect(await sorted()).toEqual(before);
      // The IP set was not even touched: same members, same scores.
      expect(await admin.zrange(ipZset, 0, -1, 'WITHSCORES')).toEqual(membersBefore);
    }, 60_000);

    it('one IP hammering ONE account creates nothing beyond that account, once it is refused', async () => {
      const storage = await newStorage();
      for (let i = 0; i < ACCOUNT_LIMIT; i++)
        await attempt(storage, '203.0.113.7', 'victim@example.com');
      const before = await sorted();

      await inBatches(
        Array.from({ length: 1000 }, (_, i) => i),
        100,
        () => attempt(storage, '203.0.113.7', 'victim@example.com'),
      );

      expect(await sorted()).toEqual(before);
      expect(before).toHaveLength(2);
      expect(storage.getStats()).toMatchObject({ blockedByAccount: 1000, blockedByIp: 0 });
    });

    it('each IP is bounded on its own: three IPs, 5,000 emails each, exactly 3 x (1 + 120) keys', async () => {
      const storage = await newStorage();
      const ips = ['203.0.113.7', '198.51.100.9', '2001:db8:abcd:12::/64'];

      for (const ip of ips) {
        await inBatches(
          Array.from({ length: 5000 }, (_, i) => `u${i}@example.com`),
          250,
          (email) => attempt(storage, ip, email),
        );
      }

      expect(await ipKeys()).toHaveLength(3);
      expect(await accountKeys()).toHaveLength(3 * IP_LIMIT);
    }, 90_000);

    it('a smaller IP limit bounds the keys further: the cap is the configured one, not a constant', async () => {
      const storage = await newStorage({ ipLimit: 15 });

      await inBatches(
        Array.from({ length: 2000 }, (_, i) => `u${i}@example.com`),
        200,
        (email) => attempt(storage, '203.0.113.7', email),
      );

      expect(await accountKeys()).toHaveLength(15);
    });

    it('every key has a TTL no longer than the window, and holds no address, email or readable text', async () => {
      const storage = await newStorage();
      for (let i = 0; i < 30; i++) await attempt(storage, '203.0.113.7', `person${i}@example.com`);

      const keys = await loginKeys();

      expect(keys.length).toBe(31);
      for (const key of keys) {
        expect(key).toMatch(new RegExp(`^${prefix}:throttle:login:(ip|account):[0-9a-f]{64}$`));
        const ttl = await admin.pttl(key);
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(TTL);
        for (const member of await admin.zrange(key, 0, -1)) {
          expect(member).toMatch(/^[0-9a-f-]{36}$/);
        }
      }
      const everything = keys.join('\n').toLowerCase();
      for (const secret of ['203.0.113', 'person', 'example', '@']) {
        expect(everything).not.toContain(secret);
      }
    });
  });

  describe('account isolation: a bucket is one IP + one email, never the email alone', () => {
    it('the same email from another IP is a different bucket; the same IP with another email shares the IP bucket', async () => {
      const storage = await newStorage();
      for (let i = 0; i < ACCOUNT_LIMIT; i++)
        await attempt(storage, '203.0.113.7', 'ana@example.com');
      expect((await attempt(storage, '203.0.113.7', 'ana@example.com')).isBlocked).toBe(true);

      // Another IP trying the same account is not locked out (the attacker cannot lock the victim out).
      expect((await attempt(storage, '198.51.100.9', 'ana@example.com')).isBlocked).toBe(false);
      // The same IP with another email is fine too: it has its own account bucket.
      expect((await attempt(storage, '203.0.113.7', 'bob@example.com')).isBlocked).toBe(false);
      expect(await ipKeys()).toHaveLength(2);
      expect(await accountKeys()).toHaveLength(3);
    });

    it('several IPs against one account each get their own allowance, and each stays bounded by its own IP limit', async () => {
      const storage = await newStorage();
      const ips = ['203.0.113.7', '203.0.113.8', '203.0.113.9'];

      const perIp = await Promise.all(
        ips.map((ip) =>
          admittedOf(Array.from({ length: 100 }, () => attempt(storage, ip, 'victim@example.com'))),
        ),
      );

      expect(perIp.map((r) => r.admitted)).toEqual([ACCOUNT_LIMIT, ACCOUNT_LIMIT, ACCOUNT_LIMIT]);
      expect(await accountKeys()).toHaveLength(3);
      expect(await ipKeys()).toHaveLength(3);
    });
  });

  describe('shared NAT: one noisy account does not lock the others out', () => {
    it('1,000 concurrent attempts on one account use up 10 of the IP budget, not 120', async () => {
      const storage = await newStorage();

      const { admitted } = await admittedOf(
        Array.from({ length: 1000 }, () => attempt(storage, '203.0.113.7', 'noisy@example.com')),
      );
      const ipZset = (await ipKeys())[0];

      expect(admitted).toBe(ACCOUNT_LIMIT);
      expect(await admin.zcard(ipZset)).toBe(ACCOUNT_LIMIT);

      // Everybody else behind the same address still has 110 attempts left.
      let others = 0;
      for (let i = 0; i < 200; i++) {
        if (!(await attempt(storage, '203.0.113.7', `colleague${i}@example.com`)).isBlocked)
          others += 1;
      }
      expect(others).toBe(IP_LIMIT - ACCOUNT_LIMIT);
    });

    it('a request refused for the account leaves the IP set exactly as it was', async () => {
      const storage = await newStorage();
      for (let i = 0; i < ACCOUNT_LIMIT; i++)
        await attempt(storage, '203.0.113.7', 'ana@example.com');
      const ipZset = (await ipKeys())[0];
      const before = await admin.zrange(ipZset, 0, -1, 'WITHSCORES');
      const ttlBefore = await admin.pttl(ipZset);

      for (let i = 0; i < 50; i++) await attempt(storage, '203.0.113.7', 'ana@example.com');

      expect(await admin.zrange(ipZset, 0, -1, 'WITHSCORES')).toEqual(before);
      expect(await admin.pttl(ipZset)).toBeLessThanOrEqual(ttlBefore); // not renewed by a refusal
    });
  });

  describe('concurrency: exact numbers, on one connection and on several', () => {
    it('1,000 parallel attempts on one account, from 4 connections: exactly 10 get in', async () => {
      const instances = await Promise.all([newStorage(), newStorage(), newStorage(), newStorage()]);

      const { admitted } = await admittedOf(
        Array.from({ length: 1000 }, (_, i) =>
          attempt(instances[i % 4], '203.0.113.7', 'victim@example.com'),
        ),
      );

      expect(admitted).toBe(ACCOUNT_LIMIT);
      expect(await admin.zcard((await accountKeys())[0])).toBe(ACCOUNT_LIMIT);
      expect(await admin.zcard((await ipKeys())[0])).toBe(ACCOUNT_LIMIT);
      expect(await loginKeys()).toHaveLength(2);
    });

    it('1,000 parallel DIFFERENT emails from one IP, from 4 connections: exactly 120 get in, exactly 120 account keys', async () => {
      const instances = await Promise.all([newStorage(), newStorage(), newStorage(), newStorage()]);

      const { admitted } = await admittedOf(
        Array.from({ length: 1000 }, (_, i) =>
          attempt(instances[i % 4], '203.0.113.7', `u${i}@example.com`),
        ),
      );

      expect(admitted).toBe(IP_LIMIT);
      expect(await accountKeys()).toHaveLength(IP_LIMIT);
      expect(await admin.zcard((await ipKeys())[0])).toBe(IP_LIMIT);

      // 2,000 more, in parallel, over all four connections: nothing new may appear.
      const before = await sorted();
      await Promise.all(
        Array.from({ length: 2000 }, (_, i) =>
          attempt(instances[i % 4], '203.0.113.7', `late${i}@example.com`),
        ),
      );
      expect(await sorted()).toEqual(before);
    });

    it('a mix of three hot accounts and 400 distinct ones: 120 in total, and every count adds up', async () => {
      const instances = await Promise.all([newStorage(), newStorage(), newStorage()]);
      const hot = ['a@example.com', 'b@example.com', 'c@example.com'];
      const demand: string[] = [
        ...hot.flatMap((email) => Array.from({ length: 500 }, () => email)),
        ...Array.from({ length: 400 }, (_, i) => `distinct${i}@example.com`),
      ].sort(() => 0.5 - Math.random());

      const { admitted } = await admittedOf(
        demand.map((email, i) => attempt(instances[i % 3], '203.0.113.7', email)),
      );

      const ipCount = await admin.zcard((await ipKeys())[0]);
      const accounts = await accountKeys();
      const perAccount = await Promise.all(accounts.map((key) => admin.zcard(key)));
      expect(admitted).toBe(IP_LIMIT);
      expect(ipCount).toBe(IP_LIMIT);
      // Every admission added one hit to the IP AND one to exactly one account, never one without the other.
      expect(perAccount.reduce((a, b) => a + b, 0)).toBe(IP_LIMIT);
      expect(Math.max(...perAccount)).toBeLessThanOrEqual(ACCOUNT_LIMIT);
      expect(accounts.length).toBeLessThanOrEqual(IP_LIMIT);
    });
  });

  describe('Lua safety: a failure never leaves a counter half-changed', () => {
    const run = (ipKey: string, accountKey: string, ...args: unknown[]) =>
      (admin as unknown as { loginProbe: (...a: unknown[]) => Promise<unknown> }).loginProbe(
        ipKey,
        accountKey,
        ...args,
      );
    beforeAll(() =>
      admin.defineCommand('loginProbe', { numberOfKeys: 2, lua: THROTTLE_LOGIN_SCRIPT }),
    );

    it('a wrong-typed ACCOUNT key fails the attempt, and the IP counter and key set are untouched', async () => {
      fallbackExpected = true;
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const storage = await newStorage();
      for (let i = 0; i < 3; i++) await attempt(storage, '203.0.113.7', `u${i}@example.com`);
      // One real attempt creates the keys of 'poison@', which tells us the account key's name.
      const known = await accountKeys();
      await attempt(storage, '203.0.113.7', 'poison@example.com');
      const poisoned = (await accountKeys()).find((key) => !known.includes(key)) as string;
      await admin.del(poisoned);
      await admin.set(poisoned, 'not-a-zset');
      const ipZset = (await ipKeys())[0];
      const keysBefore = await sorted();
      const ipBefore = await admin.zrange(ipZset, 0, -1, 'WITHSCORES');
      expect(ipBefore).toHaveLength(4 * 2); // four admitted attempts, each member with its score

      await expect(attempt(storage, '203.0.113.7', 'poison@example.com')).rejects.toBeInstanceOf(
        ThrottleUnavailableException,
      );

      expect(await sorted()).toEqual(keysBefore);
      expect(await admin.zrange(ipZset, 0, -1, 'WITHSCORES')).toEqual(ipBefore);
      expect(await admin.get(poisoned)).toBe('not-a-zset');
    });

    it('a wrong-typed IP key fails the attempt and no account key is created', async () => {
      fallbackExpected = true;
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const storage = await newStorage();
      await attempt(storage, '203.0.113.7', 'first@example.com');
      const ipKey = (await ipKeys())[0];
      await admin.del((await accountKeys())[0]);
      await admin.del(ipKey);
      await admin.set(ipKey, 'not-a-zset');
      const before = await sorted();

      await expect(attempt(storage, '203.0.113.7', 'second@example.com')).rejects.toBeInstanceOf(
        ThrottleUnavailableException,
      );

      expect(await sorted()).toEqual(before);
      expect(await accountKeys()).toEqual([]);
    });

    it.each([
      ['a zero ttl', [0, 5, 3, 'm']],
      ['a negative ttl', [-5, 5, 3, 'm']],
      ['a fractional ttl', [1.5, 5, 3, 'm']],
      ['a text ttl', ['abc', 5, 3, 'm']],
      ['a negative ip limit', [1000, -1, 3, 'm']],
      ['a fractional account limit', [1000, 5, 2.5, 'm']],
      ['a text limit', [1000, 'x', 3, 'm']],
      ['an empty member', [1000, 5, 3, '']],
    ])('%s is rejected before anything is written or trimmed', async (_label, args) => {
      const ipKey = `${prefix}:raw:ip`;
      const accountKey = `${prefix}:raw:account`;
      await admin.zadd(ipKey, 1, 'long-expired'); // an EXPIRED member: any trimming would remove it
      await admin.pexpire(ipKey, 30_000);

      await expect(run(ipKey, accountKey, ...args)).rejects.toThrow(/ERR invalid/);

      expect(await admin.zrange(ipKey, 0, -1)).toEqual(['long-expired']);
      expect(await admin.exists(accountKey)).toBe(0);
      expect(await admin.pttl(ipKey)).toBeLessThanOrEqual(30_000);
    });

    it('a REFUSED attempt performs no write at all: no trimming of expired hits, no TTL renewal, no new key', async () => {
      const ipKey = `${prefix}:raw:ip`;
      const accountKey = `${prefix}:raw:account`;
      const live = Date.now() + 60_000;
      await admin.zadd(ipKey, 1, 'long-expired', live, 'live-1', live + 1, 'live-2');
      await admin.pexpire(ipKey, 30_000);

      // ip limit 2 = the two live hits: blocked by the IP.
      const byIp = (await run(ipKey, accountKey, 60_000, 2, 5, 'new')) as number[];
      expect(byIp[0]).toBe(1);
      // Make the IP roomy and the account full instead: blocked by the account.
      await admin.zadd(accountKey, live, 'a-1', live + 1, 'a-2');
      const byAccount = (await run(ipKey, accountKey, 60_000, 100, 2, 'new')) as number[];
      expect(byAccount[0]).toBe(2);

      expect(await admin.zrange(ipKey, 0, -1)).toEqual(['long-expired', 'live-1', 'live-2']);
      expect(await admin.zrange(accountKey, 0, -1)).toEqual(['a-1', 'a-2']);
      expect(await admin.pttl(ipKey)).toBeLessThanOrEqual(30_000);
      expect(await admin.pttl(accountKey)).toBe(-1); // never given a TTL by a refusal
    });

    it('an ADMITTED attempt does the writes: trims expired hits, adds one to each set, renews both TTLs', async () => {
      const ipKey = `${prefix}:raw:ip`;
      const accountKey = `${prefix}:raw:account`;
      await admin.zadd(ipKey, 1, 'long-expired');

      const admitted = (await run(ipKey, accountKey, 60_000, 5, 3, 'm1')) as number[];

      expect(admitted[0]).toBe(0);
      expect(await admin.zrange(ipKey, 0, -1)).toEqual(['m1']);
      expect(await admin.zrange(accountKey, 0, -1)).toEqual(['m1']);
      for (const key of [ipKey, accountKey]) {
        const ttl = await admin.pttl(key);
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(60_000);
      }
    });
  });

  describe('against a simple reference model', () => {
    it('600 random attempts over 3 IPs and 25 emails decide exactly like the model, and leave the same counts', async () => {
      const ipLimit = 20;
      const accountLimit = 3;
      const storage = await newStorage({ ipLimit });
      const random = mulberry32(20261110);
      const ips = ['203.0.113.7', '198.51.100.9', '2001:db8:abcd:12::/64'];
      const model = { ip: new Map<string, number>(), account: new Map<string, number>() };

      for (let i = 0; i < 600; i++) {
        const ip = ips[Math.floor(random() * ips.length)];
        const email = `user${Math.floor(random() * 25)}@example.com`;
        const accountId = `${ip}|${email}`;
        const ipCount = model.ip.get(ip) ?? 0;
        const accountCount = model.account.get(accountId) ?? 0;
        const expected =
          ipCount >= ipLimit ? 'ip' : accountCount >= accountLimit ? 'account' : 'admitted';
        if (expected === 'admitted') {
          model.ip.set(ip, ipCount + 1);
          model.account.set(accountId, accountCount + 1);
        }
        const before = storage.getStats();

        const record = await attempt(storage, ip, email, accountLimit);

        const after = storage.getStats();
        const actual = !record.isBlocked
          ? 'admitted'
          : after.blockedByIp > before.blockedByIp
            ? 'ip'
            : 'account';
        expect(actual, `step ${i}: ${accountId}`).toBe(expected);
      }

      expect(await ipKeys()).toHaveLength(model.ip.size);
      expect(await accountKeys()).toHaveLength(model.account.size);
      const stored = await Promise.all((await accountKeys()).map((key) => admin.zcard(key)));
      expect(stored.reduce((a, b) => a + b, 0)).toBe(
        [...model.account.values()].reduce((a, b) => a + b, 0),
      );
    }, 60_000);
  });

  describe('time', () => {
    it('after the window the hits stop counting and every key disappears', async () => {
      const storage = await newStorage();
      const short = (email: string) =>
        storage.increment(`1.2.3.4|${email}`, 1500, 2, 0, LOGIN_THROTTLER);
      await short('a@example.com');
      await short('a@example.com');
      expect((await short('a@example.com')).isBlocked).toBe(true);

      await sleep(1700);

      expect((await short('a@example.com')).isBlocked).toBe(false);
      await sleep(1700);
      expect(await loginKeys()).toEqual([]);
    });

    it('the wait it reports is the time until the oldest counting hit leaves, in whole seconds', async () => {
      const storage = await newStorage();
      const short = () => storage.increment('1.2.3.4|a@example.com', 2000, 1, 0, LOGIN_THROTTLER);
      await short();

      const blocked = await short();

      expect(blocked.isBlocked).toBe(true);
      expect(blocked.timeToBlockExpire).toBeGreaterThanOrEqual(1);
      expect(blocked.timeToBlockExpire).toBeLessThanOrEqual(2);
    });

    it('instances whose clocks are an hour apart agree on both limits (time comes from Redis)', async () => {
      const ahead = await newStorage({ ipLimit: 4 });
      const behind = await newStorage({ ipLimit: 4 });
      const skewed = async <T>(offsetMs: number, work: () => Promise<T>): Promise<T> => {
        const real = Date.now.bind(Date);
        vi.spyOn(Date, 'now').mockImplementation(() => real() + offsetMs);
        try {
          return await work();
        } finally {
          vi.restoreAllMocks();
        }
      };

      const results = [];
      results.push(await skewed(3_600_000, () => attempt(ahead, '1.2.3.4', 'a@example.com', 3)));
      results.push(await skewed(-3_600_000, () => attempt(behind, '1.2.3.4', 'b@example.com', 3)));
      results.push(await skewed(3_600_000, () => attempt(ahead, '1.2.3.4', 'c@example.com', 3)));
      results.push(await skewed(-3_600_000, () => attempt(behind, '1.2.3.4', 'd@example.com', 3)));
      const fifth = await skewed(3_600_000, () => attempt(ahead, '1.2.3.4', 'e@example.com', 3));

      expect(results.every((r) => !r.isBlocked)).toBe(true);
      expect(fifth.isBlocked).toBe(true); // the IP limit of 4, counted across both skewed instances
      expect(fifth.timeToBlockExpire).toBeGreaterThanOrEqual(1);
      expect(fifth.timeToBlockExpire).toBeLessThanOrEqual(60);
    });
  });

  describe('namespaces', () => {
    it('login keys stay under their own sub-namespace, apart from plain counters and from BullMQ', async () => {
      const queue = new Queue('notifications', { connection: redisConfig, prefix });
      try {
        await queue.add('probe', { organizationId: 'org-1' });
        const storage = await newStorage();
        await attempt(storage, '203.0.113.7', 'ana@example.com');
        await storage.increment('plain-key', TTL, 5, 0, 'default');

        const all = await scanKeys(admin, `${prefix}:*`);
        const throttle = all.filter((k) => k.startsWith(`${prefix}:throttle:`));
        const queueKeys = all.filter((k) => !k.startsWith(`${prefix}:throttle:`));

        for (const key of throttle) {
          expect(key).toMatch(
            new RegExp(`^${prefix}:throttle:(hits:|window:|login:ip:|login:account:)`),
          );
        }
        expect(throttle.filter((k) => k.includes(':login:'))).toHaveLength(2);
        expect(throttle.filter((k) => k.includes(':hits:') || k.includes(':window:'))).toHaveLength(
          2,
        );
        expect(queueKeys.length).toBeGreaterThan(0);
        for (const key of queueKeys) expect(key.startsWith(`${prefix}:notifications:`)).toBe(true);
      } finally {
        await queue.obliterate({ force: true });
        await queue.close();
      }
    });
  });
});
