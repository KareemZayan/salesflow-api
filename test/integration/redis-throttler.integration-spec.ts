import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { ThrottlerStorageService } from '@nestjs/throttler';
import { Queue } from 'bullmq';
import { ThrottleUnavailableException } from '../../src/common/exceptions/throttle-unavailable.exception';
import { RedisThrottlerStorage } from '../../src/infrastructure/throttler/redis-throttler.storage';
import { THROTTLE_HIT_SCRIPT } from '../../src/infrastructure/throttler/throttle-hit.script';
import { createThrottleRedis } from '../../src/infrastructure/throttler/throttle-redis.client';
import { deleteKeysWithPrefix, scanKeys, testRedis } from '../support/redis-keys';

// ADR 0016, 15c, against the real compose Redis: the Lua script behaves like the library's own
// in-memory storage, is atomic, takes its time from Redis, and leaves no key without an expiry.
// Each test owns a random prefix and removes only what is under it.
const AUTH = 'auth';
const DEFAULT = 'default';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Redis throttler storage (integration, real Redis)', () => {
  const port = Number(process.env.TEST_REDIS_PORT);
  const redisConfig = {
    host: '127.0.0.1',
    port,
    password: process.env.REDIS_PASSWORD || undefined,
  };
  const admin = testRedis();
  const storages: RedisThrottlerStorage[] = [];
  // The storages of the running test. A silent fallback to the in-memory limiter would make most of
  // these checks pass for the wrong reason, so every test must have used Redis for every request.
  let thisTest: RedisThrottlerStorage[] = [];
  let fallbackExpected = false;
  const prefixes: string[] = [];
  let prefix: string;

  const newStorage = async (forPrefix = prefix) => {
    const storage = new RedisThrottlerStorage(
      createThrottleRedis(redisConfig, { prefix: forPrefix }),
      {
        failClosedThrottlers: new Set([AUTH]),
      },
    );
    storages.push(storage);
    thisTest.push(storage);
    // As at application startup: Nest awaits onModuleInit before it listens, and this waits for the
    // connection. Without it the first commands would fail (no offline queue) and fall back.
    await storage.onModuleInit();
    return storage;
  };
  const throttleKeys = () => scanKeys(admin, `${prefix}:throttle:*`);

  beforeEach(() => {
    prefix = `thr-int-${randomUUID().slice(0, 8)}`;
    prefixes.push(prefix);
    thisTest = [];
    fallbackExpected = false;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (fallbackExpected) return;
    for (const storage of thisTest) {
      expect(storage.getStats()).toMatchObject({ servedByFallback: 0, rejectedUnavailable: 0 });
    }
  });
  afterAll(async () => {
    for (const storage of storages) storage.onModuleDestroy();
    for (const used of prefixes) await deleteKeysWithPrefix(admin, `${used}:`);
    admin.disconnect();
  });

  describe('parity with the library in-memory storage', () => {
    // Real time, so the hits are placed away from the instants where a result changes by a whole
    // second (remaining time of 0.5 s, 1.5 s ... from the window end), which keeps the two clocks'
    // few milliseconds of difference from ever flipping a rounded value.
    interface Sequence {
      name: string;
      ttl: number;
      limit: number;
      at: number[];
    }
    const sequences: Sequence[] = [
      {
        name: 'a burst up to and past the limit',
        ttl: 2500,
        limit: 3,
        at: [0, 50, 100, 300, 900, 1100],
      },
      {
        name: 'limit 1, then the window passes',
        ttl: 2500,
        limit: 1,
        at: [0, 200, 1250, 2650, 2700],
      },
      {
        name: 'sliding: old hits leave one at a time',
        ttl: 2500,
        limit: 3,
        at: [0, 700, 1400, 1900, 2650, 2800],
      },
      {
        name: 'just before and just after the window ends',
        ttl: 2000,
        limit: 2,
        at: [0, 300, 1900, 2100, 2200],
      },
      {
        name: 'a larger burst, longer window',
        ttl: 3500,
        limit: 5,
        at: [0, 20, 40, 60, 80, 100, 120],
      },
    ];

    it.each(sequences)(
      '$name',
      async ({ ttl, limit, at }) => {
        const memory = new ThrottlerStorageService();
        const redis = await newStorage();
        const key = `parity-${randomUUID()}`;
        const startedAt = Date.now();
        const compared: Array<{ at: number; memory: unknown; redis: unknown }> = [];

        for (const offset of at) {
          await sleep(Math.max(0, startedAt + offset - Date.now()));
          const [fromMemory, fromRedis] = await Promise.all([
            memory.increment(key, ttl, limit, 0, DEFAULT),
            redis.increment(key, ttl, limit, 0, DEFAULT),
          ]);
          compared.push({ at: offset, memory: fromMemory, redis: fromRedis });
        }

        // Every field of every step: totalHits, isBlocked, timeToExpire and timeToBlockExpire, which
        // includes the hit at limit + 1.
        for (const step of compared)
          expect({ at: step.at, ...(step.redis as object) }).toEqual({
            at: step.at,
            ...(step.memory as object),
          });
        // The sequences really do reach the limit and cross it.
        expect(compared.some((s) => (s.redis as { isBlocked: boolean }).isBlocked)).toBe(true);
        expect(compared.some((s) => !(s.redis as { isBlocked: boolean }).isBlocked)).toBe(true);
      },
      15_000,
    );

    it('the hit at limit + 1 reports the same timeToExpire and timeToBlockExpire', async () => {
      const memory = new ThrottlerStorageService();
      const redis = await newStorage();
      const key = `parity-${randomUUID()}`;

      let last: [unknown, unknown] = [undefined, undefined];
      for (let hit = 1; hit <= 4; hit++) {
        last = await Promise.all([
          memory.increment(key, 2500, 3, 0, DEFAULT),
          redis.increment(key, 2500, 3, 0, DEFAULT),
        ]);
      }

      const [fromMemory, fromRedis] = last as [Record<string, number>, Record<string, number>];
      expect(fromRedis.isBlocked).toBe(true);
      expect(fromRedis.totalHits).toBe(4);
      expect(fromRedis.timeToExpire).toBe(fromMemory.timeToExpire);
      expect(fromRedis.timeToBlockExpire).toBe(fromMemory.timeToBlockExpire);
      expect(fromRedis.timeToBlockExpire).toBeGreaterThan(0);
    });
  });

  describe('atomicity and sharing', () => {
    it('100 concurrent hits against limit 10 let exactly 10 through, on one connection', async () => {
      const storage = await newStorage();

      const records = await Promise.all(
        Array.from({ length: 100 }, () => storage.increment('burst', 5000, 10, 0, DEFAULT)),
      );

      expect(records.filter((r) => !r.isBlocked)).toHaveLength(10);
      expect(records.filter((r) => r.isBlocked)).toHaveLength(90);
    });

    it('100 concurrent hits spread over several instances (connections) still let exactly 10 through', async () => {
      const instances = await Promise.all([newStorage(), newStorage(), newStorage(), newStorage()]);

      const records = await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          instances[i % instances.length].increment('burst', 5000, 10, 0, DEFAULT),
        ),
      );

      expect(records.filter((r) => !r.isBlocked)).toHaveLength(10);
    });

    it('a blocked hit adds nothing: the set never holds more than the limit', async () => {
      const storage = await newStorage();
      for (let i = 0; i < 40; i++) await storage.increment('bounded', 5000, 5, 0, DEFAULT);

      const [hitsKey] = (await throttleKeys()).filter((k) => k.includes(':hits:bounded'));
      expect(await admin.zcard(hitsKey)).toBe(5);
    });

    it('a second instance on the same Redis sees the same counter', async () => {
      const first = await newStorage();
      const second = await newStorage();

      await first.increment('shared', 5000, 3, 0, AUTH);
      await first.increment('shared', 5000, 3, 0, AUTH);
      const third = await second.increment('shared', 5000, 3, 0, AUTH);
      const fourth = await first.increment('shared', 5000, 3, 0, AUTH);

      expect(third).toMatchObject({ totalHits: 3, isBlocked: false });
      expect(fourth).toMatchObject({ totalHits: 4, isBlocked: true });
    });

    it('the counters of different prefixes are separate (two environments on one Redis)', async () => {
      const other = await newStorage(`${prefix}-other`);
      prefixes.push(`${prefix}-other`);
      const mine = await newStorage();

      await mine.increment('same-key', 5000, 1, 0, DEFAULT);

      expect(await other.increment('same-key', 5000, 1, 0, DEFAULT)).toMatchObject({
        totalHits: 1,
        isBlocked: false,
      });
    });
  });

  describe('time comes from Redis, not from the instances', () => {
    // The two instances' Date.now() disagree by two hours. If any client time took part in a
    // decision, the 1-hour-ahead instance would write hits that expire an hour late (or the
    // 1-hour-behind one would write hits that are already over).
    const skewed = async <T>(offsetMs: number, work: () => Promise<T>): Promise<T> => {
      const real = Date.now.bind(Date);
      vi.spyOn(Date, 'now').mockImplementation(() => real() + offsetMs);
      try {
        return await work();
      } finally {
        vi.restoreAllMocks();
      }
    };

    it('instances with clocks an hour apart agree on one counter', async () => {
      const ahead = await newStorage();
      const behind = await newStorage();
      const hit = (storage: RedisThrottlerStorage) =>
        storage.increment('skew', 2000, 3, 0, DEFAULT);

      const one = await skewed(3_600_000, () => hit(ahead));
      const two = await skewed(-3_600_000, () => hit(behind));
      const three = await skewed(3_600_000, () => hit(ahead));
      const four = await skewed(-3_600_000, () => hit(behind));

      expect([one.totalHits, two.totalHits, three.totalHits, four.totalHits]).toEqual([1, 2, 3, 4]);
      expect(four.isBlocked).toBe(true);
      // One window of 2 s, whatever the callers' clocks say: if a client clock took part, the
      // remaining time would be about an hour off (positive or negative), not 1 or 2 seconds.
      for (const record of [one, two, three, four]) {
        expect(record.timeToExpire).toBeGreaterThanOrEqual(1);
        expect(record.timeToExpire).toBeLessThanOrEqual(2);
      }
      expect(four.timeToBlockExpire).toBeGreaterThanOrEqual(1);
      expect(four.timeToBlockExpire).toBeLessThanOrEqual(2);
    });

    it('a hit written by a clock an hour ahead still expires on time', async () => {
      const ahead = await newStorage();
      const behind = await newStorage();
      await skewed(3_600_000, () => ahead.increment('skew-expiry', 800, 1, 0, DEFAULT));
      await sleep(1000);

      const afterWindow = await skewed(-3_600_000, () =>
        behind.increment('skew-expiry', 800, 1, 0, DEFAULT),
      );

      expect(afterWindow).toMatchObject({ totalHits: 1, isBlocked: false });
    });

    it('the script reads TIME itself and takes no time argument', () => {
      expect(THROTTLE_HIT_SCRIPT).toContain("redis.call('TIME')");
      expect(THROTTLE_HIT_SCRIPT).not.toMatch(/ARGV\[4\]/);
    });
  });

  describe('every key has an expiry', () => {
    it('hits and window keys carry a TTL after allowed hits AND after blocked hits', async () => {
      const storage = await newStorage();
      for (let i = 0; i < 6; i++) await storage.increment('ttl', 4000, 3, 0, DEFAULT);

      const keys = await throttleKeys();

      expect(keys).toHaveLength(2);
      for (const key of keys) {
        const ttl = await admin.pttl(key);
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(4000);
      }
    });

    it('the hits key TTL is renewed on every call', async () => {
      const storage = await newStorage();
      await storage.increment('renew', 3000, 10, 0, DEFAULT);
      const [hitsKey] = (await throttleKeys()).filter((k) => k.includes(':hits:renew'));
      await sleep(600);
      const before = await admin.pttl(hitsKey);

      await storage.increment('renew', 3000, 10, 0, DEFAULT);

      expect(await admin.pttl(hitsKey)).toBeGreaterThan(before);
    });

    it('nothing is left behind once the window has passed', async () => {
      const storage = await newStorage();
      await storage.increment('gone', 600, 2, 0, DEFAULT);
      await storage.increment('gone', 600, 2, 0, DEFAULT);
      await storage.increment('gone', 600, 2, 0, DEFAULT);

      await sleep(900);

      expect(await throttleKeys()).toEqual([]);
    });

    it('the keys are the hash the guard gives, under the throttle namespace, and hold no other text', async () => {
      const storage = await newStorage();
      const hash = 'a'.repeat(64);
      await storage.increment(hash, 5000, 3, 0, DEFAULT);

      const keys = await throttleKeys();

      expect(keys.sort()).toEqual([
        `${prefix}:throttle:hits:${hash}`,
        `${prefix}:throttle:window:${hash}`,
      ]);
      const [hitsKey] = keys.filter((k) => k.includes(':hits:'));
      const members = await admin.zrange(hitsKey, 0, -1);
      expect(members[0]).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe('keys never collide with BullMQ', () => {
    it('with queue keys under the same prefix, throttle keys stay in their own namespace', async () => {
      const queue = new Queue('notifications', { connection: redisConfig, prefix });
      try {
        await queue.add('probe', { organizationId: 'org-1' });
        const storage = await newStorage();
        await storage.increment('collide', 5000, 3, 0, DEFAULT);

        const all = await scanKeys(admin, `${prefix}:*`);
        const throttle = all.filter((k) => k.startsWith(`${prefix}:throttle:`));
        const rest = all.filter((k) => !k.startsWith(`${prefix}:throttle:`));

        expect(throttle).toHaveLength(2);
        expect(rest.length).toBeGreaterThan(0);
        for (const key of rest) expect(key.startsWith(`${prefix}:notifications:`)).toBe(true);
      } finally {
        await queue.obliterate({ force: true });
        await queue.close();
      }
    });
  });

  describe('a failure inside the script is never "allowed"', () => {
    it('a key of the wrong type makes the script fail: auth is refused, others use the local limiter', async () => {
      fallbackExpected = true; // this test forces the failure path
      const storage = await newStorage();
      await admin.set(`${prefix}:throttle:hits:poisoned`, 'not-a-zset');
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await expect(storage.increment('poisoned', 5000, 3, 0, AUTH)).rejects.toBeInstanceOf(
        ThrottleUnavailableException,
      );
      const local = [];
      for (let i = 0; i < 4; i++)
        local.push(await storage.increment('poisoned', 5000, 3, 0, DEFAULT));

      expect(local.map((r) => r.isBlocked)).toEqual([false, false, false, true]);
      expect(await admin.get(`${prefix}:throttle:hits:poisoned`)).toBe('not-a-zset');
    });
  });

  describe('startup eviction check', () => {
    it('is silent on a Redis with noeviction (the compose default)', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const [, policy] = (await admin.call('CONFIG', 'GET', 'maxmemory-policy')) as string[];
      expect(policy).toBe('noeviction');

      await newStorage(); // runs onModuleInit, which performs the check

      expect(warn).not.toHaveBeenCalled();
    });
  });
});
