import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { FAIL_CLOSED_THROTTLERS, LOGIN_THROTTLER } from '../../common/constants/throttle.constants';
import { ThrottleUnavailableException } from '../../common/exceptions/throttle-unavailable.exception';
import { RedisThrottlerStorage } from './redis-throttler.storage';
import { ThrottleRedis } from './throttle-redis.client';

// The COMBINED login operation as the storage drives it (ADR 0016, 15c.1). What the script itself does is
// proven against a real Redis in test/integration/redis-login-throttler.integration-spec.ts; here the
// client is a fake, so the storage's own rules can be checked exactly: which keys it asks for, what it
// hashes, how it reads the reply, and what a failure means.
const IP_LIMIT = 120;
const ACCOUNT_LIMIT = 10;
const TTL = 60_000;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

type Fake = { [K in keyof ThrottleRedis]: ReturnType<typeof vi.fn> };
const fakeClient = (): Fake => ({
  hit: vi.fn().mockResolvedValue([1, 60, 0, 0]),
  loginHit: vi.fn().mockResolvedValue([0, 1, 60, 0]),
  ping: vi.fn().mockResolvedValue('PONG'),
  whenReady: vi.fn().mockResolvedValue(undefined),
  evictionSettings: vi.fn().mockResolvedValue({ policy: 'noeviction', maxmemoryBytes: 0 }),
  close: vi.fn(),
});

function setup() {
  const client = fakeClient();
  const fallback = { increment: vi.fn() };
  const storage = new RedisThrottlerStorage(client as unknown as ThrottleRedis, {
    failClosedThrottlers: FAIL_CLOSED_THROTTLERS,
    compositeThrottlers: new Map([[LOGIN_THROTTLER, { ipLimit: IP_LIMIT }]]),
    fallback: fallback as never,
    now: () => 0,
    newMember: () => 'member-1',
    timeoutMs: 50,
  });
  const login = (tracker: string, name = LOGIN_THROTTLER) =>
    storage.increment(tracker, TTL, ACCOUNT_LIMIT, 0, name);
  return { client, fallback, storage, login };
}

describe('RedisThrottlerStorage: the combined login operation', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  describe('the keys it asks Redis for', () => {
    it('hashes both halves: the IP key from the address, the account key from IP + email', async () => {
      const { client, login } = setup();

      await login('203.0.113.7|ana@example.com');

      expect(client.loginHit).toHaveBeenCalledWith(
        `login:ip:${sha('203.0.113.7')}`,
        `login:account:${sha('203.0.113.7|ana@example.com')}`,
        TTL,
        IP_LIMIT,
        ACCOUNT_LIMIT,
        'member-1',
      );
    });

    it('never hands Redis a raw address or email, in a key or anywhere else', async () => {
      const { client, login } = setup();

      await login('203.0.113.7|ana@example.com');

      const everything = JSON.stringify(client.loginHit.mock.calls);
      expect(everything).not.toContain('203.0.113.7');
      expect(everything).not.toContain('ana@example.com');
      expect(everything).not.toContain('example');
    });

    it('splits at the FIRST "|": an email may contain one, an address never does', async () => {
      const { client, login } = setup();

      await login('203.0.113.7|we|ird@example.com');

      const [ipKey, accountKey] = client.loginHit.mock.calls[0];
      expect(ipKey).toBe(`login:ip:${sha('203.0.113.7')}`);
      expect(accountKey).toBe(`login:account:${sha('203.0.113.7|we|ird@example.com')}`);
    });

    it('an IPv6 /64 as the address is hashed as given (already normalized by the tracker)', async () => {
      const { client, login } = setup();

      await login('2001:db8:abcd:12::/64|ana@example.com');

      expect(client.loginHit.mock.calls[0][0]).toBe(`login:ip:${sha('2001:db8:abcd:12::/64')}`);
    });

    it('an empty email still has an account bucket (the garbage-body bucket of that IP)', async () => {
      const { client, login } = setup();

      await login('203.0.113.7|');

      expect(client.loginHit.mock.calls[0][1]).toBe(`login:account:${sha('203.0.113.7|')}`);
    });

    it('ACCOUNT ISOLATION: the same email from two IPs is two buckets, the same IP shares one IP bucket', async () => {
      const { client, login } = setup();

      await login('203.0.113.7|ana@example.com');
      await login('198.51.100.9|ana@example.com');
      await login('203.0.113.7|bob@example.com');
      await login('203.0.113.7|ana@example.com');

      const [first, otherIp, otherEmail, again] = client.loginHit.mock.calls;
      expect(first[1]).not.toBe(otherIp[1]); // same email, different IP: different account bucket
      expect(first[0]).not.toBe(otherIp[0]); // and a different IP bucket
      expect(first[0]).toBe(otherEmail[0]); // same IP, different email: ONE IP bucket
      expect(first[1]).not.toBe(otherEmail[1]); // ... but different account buckets
      expect(first.slice(0, 2)).toEqual(again.slice(0, 2)); // same IP + email: the same buckets
    });

    it('lives in its own namespace: neither `login:ip:` nor `login:account:` can equal a plain counter key', async () => {
      const { client, login } = setup();
      await login('203.0.113.7|ana@example.com');
      await login('203.0.113.7|ana@example.com', 'default');

      const [ipKey, accountKey] = client.loginHit.mock.calls[0];
      const [plainHits, plainWindow] = client.hit.mock.calls[0];
      for (const key of [ipKey, accountKey]) {
        expect(key.startsWith('login:')).toBe(true);
        expect(key).not.toBe(plainHits);
        expect(key).not.toBe(plainWindow);
      }
      expect(plainHits.startsWith('hits:')).toBe(true);
    });
  });

  describe('how it reads the answer', () => {
    it('status 0 is admitted', async () => {
      const { client, login } = setup();
      client.loginHit.mockResolvedValue([0, 4, 51, 0]);

      expect(await login('1.2.3.4|a@b.co')).toEqual({
        totalHits: 4,
        timeToExpire: 51,
        isBlocked: false,
        timeToBlockExpire: 0,
      });
    });

    it('status 1 is blocked by the IP, status 2 by the account, and both are counted apart', async () => {
      const { client, login, storage } = setup();
      client.loginHit.mockResolvedValueOnce([1, 121, 30, 30]);
      client.loginHit.mockResolvedValueOnce([2, 11, 12, 12]);
      client.loginHit.mockResolvedValueOnce([2, 11, 12, 12]);

      const byIp = await login('1.2.3.4|a@b.co');
      const byAccount = await login('1.2.3.4|a@b.co');
      await login('1.2.3.4|a@b.co');

      expect(byIp).toMatchObject({ isBlocked: true, timeToBlockExpire: 30 });
      expect(byAccount).toMatchObject({ isBlocked: true, timeToBlockExpire: 12 });
      expect(storage.getStats()).toMatchObject({ blockedByIp: 1, blockedByAccount: 2 });
    });

    it('a blocked request is not a failure: it never moves the breaker or the refusal counter', async () => {
      const { client, login, storage } = setup();
      client.loginHit.mockResolvedValue([1, 121, 30, 30]);

      for (let i = 0; i < 5; i++) await login('1.2.3.4|a@b.co');

      expect(storage.getStats()).toMatchObject({
        state: 'closed',
        consecutiveFailures: 0,
        rejectedUnavailable: 0,
      });
    });

    it.each([
      ['no reply', undefined],
      ['not an array', 'OK'],
      ['the wrong length', [0, 1, 60]],
      ['a non-number', [0, 1, 60, 'x']],
      ['NaN', [0, Number.NaN, 60, 0]],
      ['an unknown status', [3, 1, 60, 0]],
      ['a negative status', [-1, 1, 60, 0]],
    ])('%s is a failure, refused like any other, never "admitted"', async (_label, reply) => {
      const { client, login } = setup();
      client.loginHit.mockResolvedValue(reply);

      await expect(login('1.2.3.4|a@b.co')).rejects.toBeInstanceOf(ThrottleUnavailableException);
    });
  });

  describe('failure and recovery', () => {
    it('login is in the fail-closed set; logout/default and the rest are not', () => {
      expect([...FAIL_CLOSED_THROTTLERS].sort()).toEqual(['auth', 'login']);
      expect(FAIL_CLOSED_THROTTLERS.has('default')).toBe(false);
    });

    it('a failed login is refused with 503 THROTTLE_UNAVAILABLE and does NOT fall back to a local counter', async () => {
      const { client, fallback, login } = setup();
      client.loginHit.mockRejectedValue(new Error('down'));

      await expect(login('1.2.3.4|a@b.co')).rejects.toBeInstanceOf(ThrottleUnavailableException);

      expect(fallback.increment).not.toHaveBeenCalled();
    });

    it('costs exactly ONE Redis call per login (the two limits are decided together)', async () => {
      const { client, login } = setup();

      await login('1.2.3.4|a@b.co');

      expect(client.loginHit).toHaveBeenCalledTimes(1);
      expect(client.hit).not.toHaveBeenCalled();
    });

    it('opens the breaker after 3 failures and then refuses without calling Redis, counting each refusal', async () => {
      const { client, login, storage } = setup();
      client.loginHit.mockRejectedValue(new Error('down'));
      for (let i = 0; i < 3; i++) await login('1.2.3.4|a@b.co').catch(() => undefined);
      client.loginHit.mockClear();

      await expect(login('1.2.3.4|a@b.co')).rejects.toBeInstanceOf(ThrottleUnavailableException);

      expect(client.loginHit).not.toHaveBeenCalled();
      expect(storage.getStats()).toMatchObject({ state: 'open', rejectedUnavailable: 4 });
    });

    it('a timeout is a failure too', async () => {
      const { client, login } = setup();
      client.loginHit.mockReturnValue(new Promise(() => undefined));

      await expect(login('1.2.3.4|a@b.co')).rejects.toBeInstanceOf(ThrottleUnavailableException);
    });

    it('a key that is not "<ip>|<email>" is a bug: a plain error, not a Redis failure, never "allowed"', async () => {
      const { client, login, storage } = setup();

      for (const bad of ['1.2.3.4', '|a@b.co', '']) {
        const error = await login(bad).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(ThrottleUnavailableException);
      }

      expect(client.loginHit).not.toHaveBeenCalled();
      expect(storage.getStats()).toMatchObject({ consecutiveFailures: 0, rejectedUnavailable: 0 });
    });

    it('a blockDuration above 0 is still refused loudly for this throttler', async () => {
      const { client, storage } = setup();

      await expect(
        storage.increment('1.2.3.4|a@b.co', TTL, 10, 1000, LOGIN_THROTTLER),
      ).rejects.toThrow(/blockDuration/);

      expect(client.loginHit).not.toHaveBeenCalled();
    });
  });

  describe('other throttlers are untouched', () => {
    it.each(['default', 'auth'])(
      '%s still uses the plain counter, never the login operation',
      async (name) => {
        const { client, storage } = setup();

        await storage.increment('some-key', TTL, 5, 0, name);

        expect(client.hit).toHaveBeenCalledWith(
          'hits:some-key',
          'window:some-key',
          TTL,
          5,
          'member-1',
        );
        expect(client.loginHit).not.toHaveBeenCalled();
      },
    );

    it('without a composite configuration nothing is routed to the login operation', async () => {
      const client = fakeClient();
      const storage = new RedisThrottlerStorage(client as unknown as ThrottleRedis, {
        failClosedThrottlers: FAIL_CLOSED_THROTTLERS,
      });

      await storage.increment('k', TTL, 5, 0, LOGIN_THROTTLER);

      expect(client.loginHit).not.toHaveBeenCalled();
      expect(client.hit).toHaveBeenCalledTimes(1);
    });
  });
});
