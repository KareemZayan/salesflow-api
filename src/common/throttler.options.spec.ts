import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModuleOptions, ThrottlerStorage } from '@nestjs/throttler';
import { ThrottleConfig } from '../config/app.config';
import { AUTH_THROTTLER } from './constants/throttle.constants';
import { AuthThrottle } from './decorators/auth-throttle.decorator';
import { buildThrottlerOptions } from './throttler.options';

const throttle: ThrottleConfig = { storage: 'redis', ttlMs: 60_000, limit: 100, authLimit: 10 };
const storage = { increment: vi.fn() } as unknown as ThrottlerStorage;

type Built = { throttlers: Array<Record<string, unknown>>; storage?: ThrottlerStorage };
const build = (...args: Parameters<typeof buildThrottlerOptions>) =>
  buildThrottlerOptions(...args) as unknown as Built;

describe('buildThrottlerOptions', () => {
  it('has the default and the auth throttler with their limits and the same window', () => {
    const { throttlers } = build(throttle, null);

    expect(throttlers).toHaveLength(2);
    expect(throttlers[0]).toMatchObject({ name: 'default', ttl: 60_000, limit: 100 });
    expect(throttlers[1]).toMatchObject({ name: AUTH_THROTTLER, ttl: 60_000, limit: 10 });
    expect(AUTH_THROTTLER).toBe('auth');
  });

  it('uses the Redis storage when one is given', () => {
    expect(build(throttle, storage).storage).toBe(storage);
  });

  it('leaves the library default (in memory) when there is none', () => {
    expect(build({ ...throttle, storage: 'memory' }, null)).not.toHaveProperty('storage');
  });

  it('says blockDuration: 0 out loud on every throttler, in memory mode too', () => {
    for (const mode of [storage, null]) {
      for (const t of build(throttle, mode).throttlers) expect(t.blockDuration).toBe(0);
    }
  });
});

// The reason blockDuration must be explicit, pinned against the real guard: in @nestjs/throttler 6.7.1
// an unset blockDuration reaches the storage as the TTL (a lockout for a whole window), not as 0.
describe('what the real ThrottlerGuard hands to the storage', () => {
  class Routes {
    plain() {
      return undefined;
    }
    @AuthThrottle()
    login() {
      return undefined;
    }
  }

  async function blockDurationSeen(options: ThrottlerModuleOptions, handler: keyof Routes) {
    const seen: number[] = [];
    const recording: ThrottlerStorage = {
      increment: async (_key, _ttl, _limit, blockDuration) => {
        seen.push(blockDuration);
        return { totalHits: 1, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 };
      },
    };
    const guard = new ThrottlerGuard(options, recording, new Reflector());
    await guard.onModuleInit();
    const http = {
      getRequest: () => ({ ip: '10.0.0.1', headers: {}, body: { email: 'a@b.co' } }),
      getResponse: () => ({ header: vi.fn() }),
    };
    const context = {
      getHandler: () => Routes.prototype[handler],
      getClass: () => Routes,
      switchToHttp: () => http,
    } as unknown as ExecutionContext;
    await guard.canActivate(context);
    return seen;
  }

  it.each(['plain', 'login'] as const)(
    'our options make %s reach the storage with blockDuration 0',
    async (handler) => {
      expect(await blockDurationSeen(buildThrottlerOptions(throttle, storage), handler)).toEqual([
        0,
      ]);
    },
  );

  it('and WITHOUT the explicit 0 the same guard would send the TTL, which is why it is explicit', async () => {
    const unset: ThrottlerModuleOptions = {
      throttlers: [{ name: 'default', ttl: 60_000, limit: 100 }],
    };

    expect(await blockDurationSeen(unset, 'plain')).toEqual([60_000]);
  });
});
