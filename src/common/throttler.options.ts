import { ThrottlerModuleOptions, ThrottlerOptions, ThrottlerStorage } from '@nestjs/throttler';
import { ThrottleConfig } from '../config/app.config';
import { assertBlockDurationDisabled } from '../infrastructure/throttler/redis-throttler.storage';
import {
  AUTH_THROTTLER,
  DEFAULT_THROTTLER,
  IPV6_SUBNET_PREFIX,
  LOGIN_THROTTLER,
} from './constants/throttle.constants';
import {
  authThrottleTracker,
  isAuthThrottled,
  isLoginThrottled,
  loginThrottleTracker,
} from './guards/throttle.util';

// `blockDuration: 0` is deliberate and must stay explicit. Unset, the guard uses the ttl instead, which
// turns the limiter into a lockout for a whole window once the limit is passed; with 0 it is the
// sliding window the Redis storage implements (ADR 0016). Memory mode gets the same behaviour from the
// same options, so development matches production.
//
// Three named throttlers; a route runs exactly ONE of them (skipIf), so what a route is limited by is
// readable from its decorator:
//   default  every route without a marker (per client IP)
//   auth     @AuthThrottle():  refresh, change-password (per client IP)
//   login    @LoginThrottle(): POST /auth/login. `limit` is the per-account limit (IP + email); the per-IP
//            limit is decided in the SAME atomic Redis operation (THROTTLE_AUTH_IP_LIMIT, held by the
//            storage). Its key is the tracker itself, `<ip>|<email>`, because the storage must split it;
//            the storage hashes both halves before anything reaches Redis.
// Logout carries no marker: it is on `default`, which degrades to a per-instance limiter instead of
// refusing, so a session can still be ended while Redis is down.
//
// `storage` is the Redis storage, or undefined for the library's in-memory one (THROTTLE_STORAGE=memory,
// development and tests only). The in-memory one has no combined operation, so in memory mode the login
// route has only the per-account limit; production refuses memory mode.
export function buildThrottlerOptions(
  throttle: ThrottleConfig,
  storage: ThrottlerStorage | null,
): ThrottlerModuleOptions {
  const throttlers: ThrottlerOptions[] = [
    {
      name: DEFAULT_THROTTLER,
      ttl: throttle.ttlMs,
      limit: throttle.limit,
      blockDuration: 0,
      skipIf: (context) => isAuthThrottled(context) || isLoginThrottled(context),
    },
    {
      name: AUTH_THROTTLER,
      ttl: throttle.ttlMs,
      limit: throttle.authLimit,
      blockDuration: 0,
      skipIf: (context) => !isAuthThrottled(context),
      getTracker: authThrottleTracker,
    },
    {
      name: LOGIN_THROTTLER,
      ttl: throttle.ttlMs,
      limit: throttle.authLimit,
      blockDuration: 0,
      skipIf: (context) => !isLoginThrottled(context),
      getTracker: loginThrottleTracker,
      generateKey: (_context, tracker) => tracker,
    },
  ];
  // Fails the application at startup, not at the first request.
  if (storage) assertBlockDurationDisabled(throttlers);
  const options = { throttlers, ipv6SubnetPrefix: IPV6_SUBNET_PREFIX };
  return storage ? { ...options, storage } : options;
}
