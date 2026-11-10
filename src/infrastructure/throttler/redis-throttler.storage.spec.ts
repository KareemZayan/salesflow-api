import { HttpStatus, Logger } from '@nestjs/common';
import { ThrottlerStorageService } from '@nestjs/throttler';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { ThrottleUnavailableException } from '../../common/exceptions/throttle-unavailable.exception';
import { RedisThrottlerStorage, assertBlockDurationDisabled } from './redis-throttler.storage';
import { ThrottleRedis } from './throttle-redis.client';

const AUTH = 'auth';
const DEFAULT = 'default';
const HEALTHY_REPLY = [1, 60, 0, 0];

const fakeClient = (): { [K in keyof ThrottleRedis]: ReturnType<typeof vi.fn> } => ({
  hit: vi.fn().mockResolvedValue(HEALTHY_REPLY),
  ping: vi.fn().mockResolvedValue('PONG'),
  whenReady: vi.fn().mockResolvedValue(undefined),
  evictionSettings: vi.fn().mockResolvedValue({ policy: 'noeviction', maxmemoryBytes: 0 }),
  close: vi.fn(),
});

function setup(
  options: { timeoutMs?: number; fallback?: { increment: ReturnType<typeof vi.fn> } } = {},
) {
  const client = fakeClient();
  const clock = { now: 0 };
  const storage = new RedisThrottlerStorage(client as unknown as ThrottleRedis, {
    failClosedThrottlers: new Set([AUTH]),
    now: () => clock.now,
    newMember: () => 'member-1',
    timeoutMs: options.timeoutMs ?? 50,
    fallback: options.fallback as never,
  });
  const hit = (name = AUTH, limit = 10) => storage.increment('k', 60_000, limit, 0, name);
  const failHits = async (times: number, name = AUTH) => {
    for (let i = 0; i < times; i++) await hit(name).catch(() => undefined);
  };
  return { client, clock, storage, hit, failHits };
}

describe('RedisThrottlerStorage', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  describe('when Redis answers', () => {
    it('returns the script reply as a record and sends the keys, window, limit and a unique member', async () => {
      const { client, hit } = setup();
      client.hit.mockResolvedValue([3, 41, 0, 0]);

      const record = await hit(DEFAULT, 5);

      expect(record).toEqual({
        totalHits: 3,
        timeToExpire: 41,
        isBlocked: false,
        timeToBlockExpire: 0,
      });
      expect(client.hit).toHaveBeenCalledWith('hits:k', 'window:k', 60_000, 5, 'member-1');
    });

    it('reports a blocked hit with the time until the oldest hit leaves the window', async () => {
      const { client, hit } = setup();
      client.hit.mockResolvedValue([11, 50, 1, 17]);

      expect(await hit()).toEqual({
        totalHits: 11,
        timeToExpire: 50,
        isBlocked: true,
        timeToBlockExpire: 17,
      });
    });
  });

  describe('a failure is never "allowed"', () => {
    it.each([
      ['a rejected command (Redis down)', () => Promise.reject(new Error('ECONNREFUSED'))],
      [
        'a script error (WRONGTYPE, a bug)',
        () => Promise.reject(new Error('ERR Error running script')),
      ],
      ['no reply', () => Promise.resolve(undefined)],
      ['a reply that is not an array', () => Promise.resolve('OK')],
      ['a reply of the wrong length', () => Promise.resolve([1, 60, 0])],
      ['a reply with a non-number', () => Promise.resolve([1, 60, 0, 'x'])],
      ['a reply with NaN', () => Promise.resolve([1, 60, Number.NaN, 0])],
    ])('an auth request is refused on %s', async (_label, reply) => {
      const { client, hit } = setup();
      client.hit.mockImplementation(reply);

      await expect(hit(AUTH)).rejects.toBeInstanceOf(ThrottleUnavailableException);
    });

    it('a request that takes longer than the timeout is a failure too', async () => {
      const { client, hit } = setup({ timeoutMs: 20 });
      client.hit.mockReturnValue(new Promise(() => undefined));

      const startedAt = Date.now();
      await expect(hit(AUTH)).rejects.toBeInstanceOf(ThrottleUnavailableException);

      expect(Date.now() - startedAt).toBeLessThan(500);
    });
  });

  describe('fail closed (auth)', () => {
    it('answers 503 THROTTLE_UNAVAILABLE with Retry-After and a message that names no infrastructure', async () => {
      const { client, hit } = setup();
      client.hit.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:6379'));

      const error = await hit(AUTH).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ThrottleUnavailableException);
      const exception = error as ThrottleUnavailableException;
      expect(exception.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(exception.getResponse()).toMatchObject({ code: ERROR_CODES.THROTTLE_UNAVAILABLE });
      expect(exception.retryAfterSeconds).toBe(5);
      expect(JSON.stringify(exception.getResponse())).not.toMatch(/redis|10\.0\.0\.5|6379|econn/i);
      expect(ERROR_CODES.THROTTLE_UNAVAILABLE).not.toBe(ERROR_CODES.DATABASE_UNAVAILABLE);
    });
  });

  describe('fail to a per-instance limiter (every other throttler)', () => {
    it('uses the fallback storage with the same key, window and limit', async () => {
      const fallback = {
        increment: vi.fn().mockResolvedValue({
          totalHits: 1,
          timeToExpire: 60,
          isBlocked: false,
          timeToBlockExpire: 0,
        }),
      };
      const { client, storage } = setup({ fallback });
      client.hit.mockRejectedValue(new Error('down'));

      await storage.increment('k', 60_000, 100, 0, DEFAULT);

      expect(fallback.increment).toHaveBeenCalledWith('k', 60_000, 100, 0, DEFAULT);
    });

    it('is never unlimited: the in-memory limiter blocks once the limit is reached', async () => {
      const { client, storage } = setup();
      client.hit.mockRejectedValue(new Error('down'));

      const results = [];
      for (let i = 0; i < 4; i++) results.push(await storage.increment('k', 60_000, 3, 0, DEFAULT));

      expect(results.map((r) => r.isBlocked)).toEqual([false, false, false, true]);
    });

    it('does not use the fallback for the fail-closed throttler', async () => {
      const fallback = { increment: vi.fn() };
      const { client, hit } = setup({ fallback });
      client.hit.mockRejectedValue(new Error('down'));

      await hit(AUTH).catch(() => undefined);

      expect(fallback.increment).not.toHaveBeenCalled();
    });
  });

  describe('circuit breaker', () => {
    it('stays closed below the threshold: Redis is still asked', async () => {
      const { client, failHits, hit } = setup();
      client.hit.mockRejectedValue(new Error('down'));
      await failHits(2);

      await hit().catch(() => undefined);

      expect(client.hit).toHaveBeenCalledTimes(3);
    });

    it('opens after 3 consecutive failures and then answers WITHOUT touching Redis', async () => {
      const { client, failHits, hit, storage } = setup();
      client.hit.mockRejectedValue(new Error('down'));
      await failHits(3);
      expect(storage.getStats().state).toBe('open');
      client.hit.mockClear();

      await expect(hit(AUTH)).rejects.toBeInstanceOf(ThrottleUnavailableException);
      await expect(hit(AUTH)).rejects.toBeInstanceOf(ThrottleUnavailableException);

      expect(client.hit).not.toHaveBeenCalled();
    });

    it('while open, a slow Redis costs nothing: requests are not made to wait for the timeout', async () => {
      const { client, failHits, hit } = setup({ timeoutMs: 400 });
      client.hit.mockRejectedValue(new Error('down'));
      await failHits(3);
      client.hit.mockReturnValue(new Promise(() => undefined));

      const startedAt = Date.now();
      await hit(AUTH).catch(() => undefined);

      expect(Date.now() - startedAt).toBeLessThan(100);
    });

    it('while open, the other throttlers use the fallback without touching Redis', async () => {
      const { client, failHits, storage } = setup();
      client.hit.mockRejectedValue(new Error('down'));
      await failHits(3);
      client.hit.mockClear();

      const record = await storage.increment('k2', 60_000, 5, 0, DEFAULT);

      expect(client.hit).not.toHaveBeenCalled();
      expect(record.isBlocked).toBe(false);
    });

    it('a success in between resets the count: 2 failures, a success, 2 failures stays closed', async () => {
      const { client, failHits, hit, storage } = setup();
      client.hit.mockRejectedValue(new Error('down'));
      await failHits(2);
      client.hit.mockResolvedValue(HEALTHY_REPLY);
      await hit();
      client.hit.mockRejectedValue(new Error('down'));
      await failHits(2);

      expect(storage.getStats()).toMatchObject({ state: 'closed', consecutiveFailures: 2 });
    });

    it('after the window, exactly ONE request probes Redis; the others still fail fast', async () => {
      const { client, clock, failHits, hit } = setup();
      client.hit.mockRejectedValue(new Error('down'));
      await failHits(3);
      client.hit.mockClear();
      clock.now = 5_000;
      let finishProbe!: (reply: unknown) => void;
      client.hit.mockReturnValue(new Promise((resolve) => (finishProbe = resolve)));

      const probe = hit(AUTH);
      const duringProbe = await hit(AUTH).catch((e: unknown) => e);
      finishProbe(HEALTHY_REPLY);
      await probe;

      expect(client.hit).toHaveBeenCalledTimes(1);
      expect(duringProbe).toBeInstanceOf(ThrottleUnavailableException);
    });

    it('closes when the probe succeeds and recovers on its own', async () => {
      const { client, clock, failHits, hit, storage } = setup();
      client.hit.mockRejectedValue(new Error('down'));
      await failHits(3);
      clock.now = 5_000;
      client.hit.mockResolvedValue(HEALTHY_REPLY);

      await expect(hit(AUTH)).resolves.toMatchObject({ totalHits: 1 });

      expect(storage.getStats()).toMatchObject({ state: 'closed', consecutiveFailures: 0 });
      await expect(hit(AUTH)).resolves.toBeDefined();
    });

    it('re-opens at once when the probe fails, without a second outage line', async () => {
      const { client, clock, failHits, hit, storage } = setup();
      client.hit.mockRejectedValue(new Error('down'));
      await failHits(3);
      clock.now = 5_000;

      await hit(AUTH).catch(() => undefined); // the probe, fails

      expect(storage.getStats().state).toBe('open');
      client.hit.mockClear();
      await hit(AUTH).catch(() => undefined);
      expect(client.hit).not.toHaveBeenCalled();
      expect(
        warn.mock.calls.filter(([m]: unknown[]) => /unavailable/i.test(String(m))),
      ).toHaveLength(1);
    });
  });

  describe('logs and counters', () => {
    it('logs the outage once however many requests fail, and the recovery once', async () => {
      const { client, clock, failHits, hit } = setup();
      client.hit.mockRejectedValue(new Error('down'));

      await failHits(6);
      clock.now = 5_000;
      client.hit.mockResolvedValue(HEALTHY_REPLY);
      await hit();
      await hit();
      await hit();

      const outage = warn.mock.calls.filter(([m]: unknown[]) =>
        /Throttle storage unavailable/.test(String(m)),
      );
      const recovery = log.mock.calls.filter(([m]: unknown[]) => /available again/.test(String(m)));
      expect(outage).toHaveLength(1);
      expect(recovery).toHaveLength(1);
    });

    it('the recovery line says how many requests were refused, and the lines name no key or tenant', async () => {
      const { client, clock, failHits, hit } = setup();
      client.hit.mockRejectedValue(new Error('down'));
      await failHits(5);
      clock.now = 5_000;
      client.hit.mockResolvedValue(HEALTHY_REPLY);
      await hit();

      const line = String(
        log.mock.calls.find(([m]: unknown[]) => /available again/.test(String(m)))?.[0],
      );
      expect(line).toMatch(/5 request\(s\) were refused with THROTTLE_UNAVAILABLE/);
      expect(line).not.toMatch(/hits:k|window:k/);
    });

    it('counts requests refused with THROTTLE_UNAVAILABLE (breaker fast path included), not fallback ones', async () => {
      const { client, failHits, storage } = setup();
      client.hit.mockRejectedValue(new Error('down'));

      await failHits(5, AUTH); // 3 reach Redis and fail, 2 are refused by the open breaker
      await storage.increment('k', 60_000, 10, 0, DEFAULT);
      await storage.increment('k', 60_000, 10, 0, DEFAULT);

      expect(storage.getStats()).toMatchObject({
        rejectedUnavailable: 5,
        rejectedDuringOutage: 5,
        servedByFallback: 2,
      });
    });

    it('the per-outage count resets after recovery while the running total is kept', async () => {
      const { client, clock, failHits, hit, storage } = setup();
      client.hit.mockRejectedValue(new Error('down'));
      await failHits(3);
      clock.now = 5_000;
      client.hit.mockResolvedValue(HEALTHY_REPLY);
      await hit();

      expect(storage.getStats()).toMatchObject({ rejectedUnavailable: 3, rejectedDuringOutage: 0 });
    });

    it('logs nothing while healthy', async () => {
      const { hit } = setup();
      await hit();
      await hit();

      expect(warn).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    });
  });

  describe('blockDuration: only an explicit 0 is supported', () => {
    it('a hit with blockDuration > 0 is refused loudly, before Redis is asked', async () => {
      const { client, storage } = setup();

      await expect(storage.increment('k', 60_000, 5, 1000, AUTH)).rejects.toThrow(/blockDuration/);

      expect(client.hit).not.toHaveBeenCalled();
    });

    it('startup validation rejects any blockDuration but an explicit 0', () => {
      expect(() =>
        assertBlockDurationDisabled([{ name: 'a', ttl: 1, limit: 1, blockDuration: 5000 }]),
      ).toThrow(/Throttler "a" must set blockDuration: 0/);
      expect(() => assertBlockDurationDisabled([{ ttl: 1, limit: 1, blockDuration: 1 }])).toThrow(
        /Throttler "default" must set blockDuration: 0/,
      );
    });

    it('rejects an UNSET blockDuration too: the guard would default it to the ttl (a full-window lockout)', () => {
      expect(() => assertBlockDurationDisabled([{ name: 'a', ttl: 1, limit: 1 }])).toThrow(
        /defaults an unset blockDuration to the ttl/,
      );
    });

    it('accepts throttlers that say blockDuration: 0', () => {
      expect(() =>
        assertBlockDurationDisabled([
          { name: 'a', ttl: 1, limit: 1, blockDuration: 0 },
          { name: 'b', ttl: 1, limit: 1, blockDuration: 0 },
        ]),
      ).not.toThrow();
    });
  });

  describe('probe (readiness)', () => {
    it('is up when Redis answers a PING', async () => {
      const { storage } = setup();
      expect(await storage.probe()).toBe(true);
    });

    it('is down when the PING fails or hangs', async () => {
      const { client, storage } = setup({ timeoutMs: 20 });
      client.ping.mockRejectedValueOnce(new Error('down'));
      expect(await storage.probe()).toBe(false);
      client.ping.mockReturnValueOnce(new Promise(() => undefined));
      expect(await storage.probe()).toBe(false);
    });

    it('is down while the breaker is open, without asking Redis', async () => {
      const { client, failHits, storage } = setup();
      client.hit.mockRejectedValue(new Error('down'));
      await failHits(3);

      expect(await storage.probe()).toBe(false);
      expect(client.ping).not.toHaveBeenCalled();
    });

    it('does not change the breaker either way', async () => {
      const { client, storage } = setup();
      client.ping.mockRejectedValue(new Error('down'));
      await storage.probe();
      await storage.probe();
      await storage.probe();

      expect(storage.getStats()).toMatchObject({ state: 'closed', consecutiveFailures: 0 });
    });
  });

  describe('startup: eviction policy', () => {
    it('warns (and does not throw) when maxmemory-policy is not noeviction', async () => {
      const { client, storage } = setup();
      client.evictionSettings.mockResolvedValue({ policy: 'allkeys-lru', maxmemoryBytes: 1024 });

      await expect(storage.onModuleInit()).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/allkeys-lru.*noeviction/s);
    });

    it('is silent with noeviction', async () => {
      const { storage } = setup();
      await storage.onModuleInit();
      expect(warn).not.toHaveBeenCalled();
    });

    it.each([
      ['CONFIG is refused (a managed Redis)', 'evictionSettings'],
      ['Redis is not reachable at startup', 'whenReady'],
    ])('never fails startup when %s', async (_label, method) => {
      const { client, storage } = setup();
      client[method as 'evictionSettings'].mockRejectedValue(new Error('NOPERM'));

      await expect(storage.onModuleInit()).resolves.toBeUndefined();

      expect(warn).not.toHaveBeenCalled();
    });
  });

  it('closes its connection on shutdown', () => {
    const { client, storage } = setup();
    storage.onModuleDestroy();
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it('really is a different limiter from the fallback it wraps', () => {
    expect(new ThrottlerStorageService()).not.toBeInstanceOf(RedisThrottlerStorage);
  });
});
