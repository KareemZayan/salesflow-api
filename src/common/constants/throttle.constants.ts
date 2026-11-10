// Names of the named throttlers. Defined once because several places must agree on them: the throttler
// options, the route decorators, and the Redis storage, which FAILS CLOSED for exactly the throttlers
// listed in FAIL_CLOSED_THROTTLERS.
//
//  - default: every route that is not an auth route (per client IP).
//  - auth:    refresh and change-password (per client IP, per route).
//  - login:   POST /auth/login, a COMBINED limit: per client IP AND per client IP + email, decided
//             together in one atomic Redis operation (ADR 0016, 15c.1).
// Logout is on `default`: it must stay available while Redis is down, and the default throttler
// degrades to a per-instance limiter instead of refusing.
export const DEFAULT_THROTTLER = 'default';
export const AUTH_THROTTLER = 'auth';
export const LOGIN_THROTTLER = 'login';

// For these, "Redis unknown" must never mean "allowed": the request is refused with 503
// THROTTLE_UNAVAILABLE.
export const FAIL_CLOSED_THROTTLERS: ReadonlySet<string> = new Set([
  AUTH_THROTTLER,
  LOGIN_THROTTLER,
]);

// IPv6 clients are limited per /64, the smallest block an ISP hands out: one residential customer
// owns 2^64 addresses, so a limit per single address could be dodged by rotating through them.
// Passed to the throttler module as `ipv6SubnetPrefix` too, so the default tracker and ours cannot differ.
export const IPV6_SUBNET_PREFIX = 64;
