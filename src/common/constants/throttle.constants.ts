// Name of the stricter throttler used by the auth routes (login, refresh, change-password). Defined
// once here because three places must agree on it: the throttler options, the `@AuthThrottle()`
// guard logic, and the Redis storage, which fails CLOSED for exactly this throttler.
export const AUTH_THROTTLER = 'auth';
