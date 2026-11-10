import { randomUUID } from 'node:crypto';
import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ThrottlerOptions, ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { ThrottleUnavailableException } from '../../common/exceptions/throttle-unavailable.exception';
import { withTimeout } from '../../common/utils/with-timeout.util';
import { ThrottleRedis } from './throttle-redis.client';
import {
  REQUIRED_EVICTION_POLICY,
  THROTTLE_BREAKER_FAILURE_THRESHOLD,
  THROTTLE_BREAKER_OPEN_MS,
  THROTTLE_OPERATION_TIMEOUT_MS,
  THROTTLE_RETRY_AFTER_SECONDS,
  THROTTLE_STARTUP_CHECK_MS,
} from './throttler.constants';

// The package does not export its record type; this is the same type, from the public interface.
type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

export interface RedisThrottlerStorageOptions {
  // Throttlers for which "Redis unknown" must NOT mean "allowed": the request is refused with
  // 503 THROTTLE_UNAVAILABLE. Every other throttler falls back to `fallback`.
  failClosedThrottlers: ReadonlySet<string>;
  // Per-instance limiter used for the other throttlers while Redis is down. It is never "unlimited",
  // but with N instances the effective limit is N times looser until Redis is back.
  fallback?: ThrottlerStorage;
  timeoutMs?: number;
  breaker?: { failureThreshold: number; openMs: number };
  // Monotonic milliseconds, for the breaker only (never for a rate-limit decision: that time comes
  // from Redis inside the script). Injected so tests do not have to wait.
  now?: () => number;
  newMember?: () => string;
}

export interface ThrottleStorageStats {
  state: 'closed' | 'open';
  consecutiveFailures: number;
  // Requests refused with THROTTLE_UNAVAILABLE since the process started, and during the outage in
  // progress (0 when there is none).
  rejectedUnavailable: number;
  rejectedDuringOutage: number;
  // Requests of the fail-open throttlers served by the per-instance fallback since the process started.
  servedByFallback: number;
}

// This storage is a sliding window and nothing else: it implements the library's `blockDuration = 0`
// branch. The guard, however, DEFAULTS an unset blockDuration to the throttler's ttl (@nestjs/throttler
// 6.7.1: `blockDuration ?? ttl`), which selects the library's other behaviour (a lockout for a whole
// window once the limit is passed). So "not configured" is the dangerous case, and every throttler must
// say `blockDuration: 0` out loud. Anything else stops the application at startup, not at a request.
export function assertBlockDurationDisabled(throttlers: readonly ThrottlerOptions[]): void {
  for (const { name, blockDuration } of throttlers) {
    if (blockDuration !== 0) {
      throw new Error(
        `Throttler "${name ?? 'default'}" must set blockDuration: 0. The guard defaults an unset ` +
          'blockDuration to the ttl (a full-window lockout), which the Redis throttler storage does not ' +
          'implement: it is a sliding window only.',
      );
    }
  }
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message || error.name : 'unknown error';

// Pattern: a Strategy for @nestjs/throttler's storage port, with a circuit breaker in front of Redis.
//
// What happens when Redis cannot be consulted (down, slow, the script failing, an unexpected reply):
//  - a FAIL-CLOSED throttler (auth) throws ThrottleUnavailableException -> 503, the request never
//    reaches the handler, so a Redis outage cannot switch brute-force protection off;
//  - any other throttler is counted by an in-memory limiter of this instance instead.
// After THRESHOLD failures in a row the breaker opens for a short window: requests are answered at
// once (no 250 ms wait each) and no command is sent. After the window one request probes Redis; the
// breaker closes when it succeeds. The outage and the recovery are each logged once.
export class RedisThrottlerStorage implements ThrottlerStorage, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private readonly failClosed: ReadonlySet<string>;
  private readonly fallback: ThrottlerStorage;
  private readonly timeoutMs: number;
  private readonly failureThreshold: number;
  private readonly openMs: number;
  private readonly now: () => number;
  private readonly newMember: () => string;

  private state: 'closed' | 'open' = 'closed';
  private openUntil = 0;
  private probing = false;
  private consecutiveFailures = 0;
  private inOutage = false;
  private rejectedTotal = 0;
  private rejectedInOutage = 0;
  private fallbackServed = 0;

  constructor(
    private readonly redis: ThrottleRedis,
    options: RedisThrottlerStorageOptions,
  ) {
    this.failClosed = options.failClosedThrottlers;
    this.fallback = options.fallback ?? new ThrottlerStorageService();
    this.timeoutMs = options.timeoutMs ?? THROTTLE_OPERATION_TIMEOUT_MS;
    this.failureThreshold = options.breaker?.failureThreshold ?? THROTTLE_BREAKER_FAILURE_THRESHOLD;
    this.openMs = options.breaker?.openMs ?? THROTTLE_BREAKER_OPEN_MS;
    this.now = options.now ?? (() => performance.now());
    this.newMember = options.newMember ?? randomUUID;
  }

  // A warning, never a failure: a managed Redis may refuse CONFIG, and a Redis that is down at boot
  // simply cannot be asked.
  async onModuleInit(): Promise<void> {
    try {
      await this.redis.whenReady(THROTTLE_STARTUP_CHECK_MS);
      const { policy, maxmemoryBytes } = await withTimeout(
        this.redis.evictionSettings(),
        this.timeoutMs,
        'Throttle eviction check',
      );
      if (policy !== REQUIRED_EVICTION_POLICY) {
        this.logger.warn(
          `Redis maxmemory-policy is "${policy}" (maxmemory ${maxmemoryBytes || 'unlimited'}), not ` +
            `"${REQUIRED_EVICTION_POLICY}": under memory pressure Redis may evict rate-limit counters ` +
            'and let requests through. The queues need noeviction as well.',
        );
      }
    } catch {
      // Unknown is not a problem to report; the check is advisory.
    }
  }

  onModuleDestroy(): void {
    this.redis.close();
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    if (blockDuration > 0) {
      throw new Error('The Redis throttler storage does not support blockDuration');
    }
    if (!this.mayCallRedis()) {
      return this.unavailable(key, ttl, limit, throttlerName);
    }
    try {
      const reply = await withTimeout(
        this.redis.hit(`hits:${key}`, `window:${key}`, ttl, limit, this.newMember()),
        this.timeoutMs,
        'Throttle storage',
      );
      const record = toRecord(reply);
      this.recordSuccess();
      return record;
    } catch (error) {
      this.recordFailure(error);
      return this.unavailable(key, ttl, limit, throttlerName);
    }
  }

  // Used by /health/ready. A real round trip, separate from the breaker so readiness never has to
  // wait for traffic; while the breaker is open it reports down without touching Redis.
  async probe(): Promise<boolean> {
    if (this.state === 'open' && this.now() < this.openUntil) return false;
    try {
      await withTimeout(this.redis.ping(), this.timeoutMs, 'Throttle storage ping');
      return true;
    } catch {
      return false;
    }
  }

  getStats(): ThrottleStorageStats {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      rejectedUnavailable: this.rejectedTotal,
      rejectedDuringOutage: this.rejectedInOutage,
      servedByFallback: this.fallbackServed,
    };
  }

  // Closed: yes. Open: no until the window passes; then exactly one caller probes.
  private mayCallRedis(): boolean {
    if (this.state === 'closed') return true;
    if (this.now() < this.openUntil) return false;
    if (this.probing) return false;
    this.probing = true;
    return true;
  }

  private recordSuccess(): void {
    this.probing = false;
    this.consecutiveFailures = 0;
    this.state = 'closed';
    if (!this.inOutage) return;
    this.inOutage = false;
    this.logger.log(
      `Throttle storage available again; ${this.rejectedInOutage} request(s) were refused with ` +
        'THROTTLE_UNAVAILABLE during the outage',
    );
    this.rejectedInOutage = 0;
  }

  private recordFailure(error: unknown): void {
    this.probing = false;
    this.consecutiveFailures += 1;
    if (!this.inOutage) {
      this.inOutage = true;
      this.rejectedInOutage = 0;
      this.logger.warn(
        `Throttle storage unavailable (${errorText(error)}): auth routes answer 503 ` +
          'THROTTLE_UNAVAILABLE, other routes are limited per instance until it recovers',
      );
    }
    // A failed probe (state already open) re-opens at once; otherwise wait for the threshold.
    if (this.state === 'open' || this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'open';
      this.openUntil = this.now() + this.openMs;
    }
  }

  private async unavailable(
    key: string,
    ttl: number,
    limit: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    if (this.failClosed.has(throttlerName)) {
      this.rejectedTotal += 1;
      this.rejectedInOutage += 1;
      throw new ThrottleUnavailableException(THROTTLE_RETRY_AFTER_SECONDS);
    }
    this.fallbackServed += 1;
    return this.fallback.increment(key, ttl, limit, 0, throttlerName);
  }
}

// The script's reply, validated: anything else is a failure, never a record that lets a request in.
function toRecord(reply: unknown): ThrottlerStorageRecord {
  if (
    !Array.isArray(reply) ||
    reply.length !== 4 ||
    !reply.every((value) => typeof value === 'number' && Number.isFinite(value))
  ) {
    throw new Error('Throttle storage returned an unexpected reply');
  }
  const [totalHits, timeToExpire, isBlocked, timeToBlockExpire] = reply as number[];
  return { totalHits, timeToExpire, isBlocked: isBlocked === 1, timeToBlockExpire };
}
