import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModuleOptions, ThrottlerStorage } from '@nestjs/throttler';
import { AuthController } from '../modules/auth/auth.controller';
import { ThrottleConfig } from '../config/app.config';
import {
  AUTH_THROTTLER,
  DEFAULT_THROTTLER,
  FAIL_CLOSED_THROTTLERS,
  IPV6_SUBNET_PREFIX,
  LOGIN_THROTTLER,
} from './constants/throttle.constants';
import { AUTH_THROTTLE_KEY, LOGIN_THROTTLE_KEY } from './constants/metadata-keys';
import { AuthThrottle } from './decorators/auth-throttle.decorator';
import { LoginThrottle } from './decorators/login-throttle.decorator';
import { buildThrottlerOptions } from './throttler.options';

const throttle: ThrottleConfig = {
  storage: 'redis',
  ttlMs: 60_000,
  limit: 100,
  authLimit: 10,
  authIpLimit: 120,
};
const storage = { increment: vi.fn() } as unknown as ThrottlerStorage;

type Built = {
  throttlers: Array<Record<string, unknown>>;
  storage?: ThrottlerStorage;
  ipv6SubnetPrefix?: number;
};
const build = (...args: Parameters<typeof buildThrottlerOptions>) =>
  buildThrottlerOptions(...args) as unknown as Built;

describe('buildThrottlerOptions', () => {
  it('has the default, auth and login throttlers with their limits and the same window', () => {
    const { throttlers } = build(throttle, null);

    expect(throttlers.map((t) => t.name)).toEqual([
      DEFAULT_THROTTLER,
      AUTH_THROTTLER,
      LOGIN_THROTTLER,
    ]);
    expect(throttlers[0]).toMatchObject({ ttl: 60_000, limit: 100 });
    expect(throttlers[1]).toMatchObject({ ttl: 60_000, limit: 10 });
    // The login throttler's own limit is the per-ACCOUNT limit; the per-IP limit lives in the storage.
    expect(throttlers[2]).toMatchObject({ ttl: 60_000, limit: 10 });
    expect([DEFAULT_THROTTLER, AUTH_THROTTLER, LOGIN_THROTTLER]).toEqual([
      'default',
      'auth',
      'login',
    ]);
  });

  it('uses the Redis storage when one is given, and the library default (memory) when not', () => {
    expect(build(throttle, storage).storage).toBe(storage);
    expect(build({ ...throttle, storage: 'memory' }, null)).not.toHaveProperty('storage');
  });

  it('says blockDuration: 0 out loud on every throttler, in memory mode too', () => {
    for (const mode of [storage, null]) {
      for (const t of build(throttle, mode).throttlers) expect(t.blockDuration).toBe(0);
    }
  });

  it('sets the IPv6 prefix to the same /64 the trackers use', () => {
    expect(IPV6_SUBNET_PREFIX).toBe(64);
    expect(build(throttle, storage).ipv6SubnetPrefix).toBe(IPV6_SUBNET_PREFIX);
  });

  it('the login throttler keeps the raw "<ip>|<email>" as its key, so the storage can split it', () => {
    const login = build(throttle, storage).throttlers[2];
    const generateKey = login.generateKey as (c: unknown, tracker: string, name: string) => string;

    expect(generateKey({}, '1.2.3.4|a@b.co', 'login')).toBe('1.2.3.4|a@b.co');
  });

  it('the fail-closed set is exactly auth and login (default degrades to a local limiter)', () => {
    expect([...FAIL_CLOSED_THROTTLERS].sort()).toEqual([AUTH_THROTTLER, LOGIN_THROTTLER]);
  });
});

// What each KIND of route actually runs, through the real guard. A route runs exactly one throttler.
describe('what the real ThrottlerGuard does for each kind of route', () => {
  class Routes {
    plain() {
      return undefined;
    }
    @AuthThrottle()
    refresh() {
      return undefined;
    }
    @LoginThrottle()
    login() {
      return undefined;
    }
  }

  interface Seen {
    throttler: string;
    key: string;
    limit: number;
    blockDuration: number;
  }

  async function seenBy(
    options: ThrottlerModuleOptions,
    handler: keyof Routes,
    req: Record<string, unknown> = { ip: '1.2.3.4', headers: {}, body: { email: 'a@b.co' } },
  ) {
    const seen: Seen[] = [];
    const recording: ThrottlerStorage = {
      increment: async (key, _ttl, limit, blockDuration, throttler) => {
        seen.push({ throttler, key, limit, blockDuration });
        return { totalHits: 1, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 };
      },
    };
    const guard = new ThrottlerGuard(options, recording, new Reflector());
    await guard.onModuleInit();
    const http = { getRequest: () => req, getResponse: () => ({ header: vi.fn() }) };
    await guard.canActivate({
      getHandler: () => Routes.prototype[handler],
      getClass: () => Routes,
      switchToHttp: () => http,
    } as unknown as ExecutionContext);
    return seen;
  }
  const options = () => buildThrottlerOptions(throttle, storage);

  it('an unmarked route (logout is one) runs only `default`, with a hashed key and blockDuration 0', async () => {
    const seen = await seenBy(options(), 'plain');

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ throttler: 'default', limit: 100, blockDuration: 0 });
    expect(seen[0].key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('@AuthThrottle (refresh, change-password) runs only `auth`', async () => {
    const seen = await seenBy(options(), 'refresh', { ip: '1.2.3.4', headers: {}, body: {} });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ throttler: 'auth', limit: 10, blockDuration: 0 });
  });

  it('@LoginThrottle runs only `login`, and hands the storage the raw "<ip>|<email>" with blockDuration 0', async () => {
    const seen = await seenBy(options(), 'login');

    expect(seen).toEqual([
      { throttler: 'login', key: '1.2.3.4|a@b.co', limit: 10, blockDuration: 0 },
    ]);
  });

  it('login normalizes the address: two addresses of one /64 reach the storage with the SAME key', async () => {
    const body = { email: 'victim@example.com' };
    const a = await seenBy(options(), 'login', { ip: '2001:db8:abcd:12::1', headers: {}, body });
    const b = await seenBy(options(), 'login', {
      ip: '2001:db8:abcd:12:ffff::9',
      headers: {},
      body,
    });
    const other = await seenBy(options(), 'login', {
      ip: '2001:db8:abcd:13::1',
      headers: {},
      body,
    });

    expect(a[0].key).toBe('2001:db8:abcd:12::/64|victim@example.com');
    expect(b[0].key).toBe(a[0].key);
    expect(other[0].key).not.toBe(a[0].key);
  });

  it('and WITHOUT the explicit 0 the same guard would send the TTL, which is why it is explicit', async () => {
    const unset: ThrottlerModuleOptions = {
      throttlers: [{ name: 'default', ttl: 60_000, limit: 100 }],
    };

    expect((await seenBy(unset, 'plain'))[0].blockDuration).toBe(60_000);
  });
});

// The decorators on the REAL controller: a typo here would silently put a route on the wrong limiter.
describe('the real AuthController routes', () => {
  const markers = (handler: keyof AuthController) => ({
    login: Reflect.getMetadata(LOGIN_THROTTLE_KEY, AuthController.prototype[handler]) === true,
    auth: Reflect.getMetadata(AUTH_THROTTLE_KEY, AuthController.prototype[handler]) === true,
  });

  it.each([
    ['login', { login: true, auth: false }],
    ['refresh', { login: false, auth: true }],
    ['changePassword', { login: false, auth: true }],
    // Logout is deliberately on neither: it must stay available while Redis is down.
    ['logout', { login: false, auth: false }],
    ['me', { login: false, auth: false }],
  ] as const)('%s', (handler, expected) => {
    expect(markers(handler)).toEqual(expected);
  });
});
