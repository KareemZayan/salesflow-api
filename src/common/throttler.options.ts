import { ThrottlerModuleOptions, ThrottlerOptions, ThrottlerStorage } from '@nestjs/throttler';
import { ThrottleConfig } from '../config/app.config';
import { assertBlockDurationDisabled } from '../infrastructure/throttler/redis-throttler.storage';
import { AUTH_THROTTLER } from './constants/throttle.constants';
import { authThrottleTracker, isAuthThrottled } from './guards/throttle.util';

// `blockDuration: 0` is deliberate and must stay explicit. Unset, the guard uses the ttl instead, which
// turns the limiter into a lockout for a whole window once the limit is passed; with 0 it is the
// sliding window the Redis storage implements (ADR 0016). Memory mode gets the same behaviour from the
// same options, so development matches production.
//
// Two named throttlers: `default` (every route) and `auth` (login and the other auth routes, per
// IP + email). A route runs exactly one of them (skipIf). `storage` is the Redis storage, or
// undefined for the library's in-memory one (THROTTLE_STORAGE=memory, development and tests only).
export function buildThrottlerOptions(
  throttle: ThrottleConfig,
  storage: ThrottlerStorage | null,
): ThrottlerModuleOptions {
  const throttlers: ThrottlerOptions[] = [
    {
      name: 'default',
      ttl: throttle.ttlMs,
      limit: throttle.limit,
      blockDuration: 0,
      skipIf: isAuthThrottled,
    },
    {
      name: AUTH_THROTTLER,
      ttl: throttle.ttlMs,
      limit: throttle.authLimit,
      blockDuration: 0,
      skipIf: (context) => !isAuthThrottled(context),
      getTracker: authThrottleTracker,
    },
  ];
  // Fails the application at startup, not at the first request.
  if (storage) assertBlockDurationDisabled(throttlers);
  return storage ? { throttlers, storage } : { throttlers };
}
