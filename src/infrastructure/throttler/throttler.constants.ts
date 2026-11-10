// One Redis round trip is made per throttled request. Past this the call is a failure, so a slow
// Redis costs a request at most this long (and, once the breaker is open, nothing).
export const THROTTLE_OPERATION_TIMEOUT_MS = 250;

// Circuit breaker: after this many failures in a row, Redis is treated as down for the open window.
// Requests are answered at once instead of each waiting for the timeout above; after the window ONE
// request probes Redis and closes the breaker if it answers.
export const THROTTLE_BREAKER_FAILURE_THRESHOLD = 3;
export const THROTTLE_BREAKER_OPEN_MS = 5000;

// Sent to a client that was refused because the limiter is down: the breaker window, rounded up.
export const THROTTLE_RETRY_AFTER_SECONDS = Math.ceil(THROTTLE_BREAKER_OPEN_MS / 1000);

// How long startup waits for the connection before skipping the eviction-policy check.
export const THROTTLE_STARTUP_CHECK_MS = 1000;

// A Redis that evicts keys under memory pressure can drop a counter early and so let requests
// through. BullMQ needs this setting too.
export const REQUIRED_EVICTION_POLICY = 'noeviction';
