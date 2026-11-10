import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { RedisThrottlerStorage } from '../../throttler/redis-throttler.storage';
import { REDIS_THROTTLER_STORAGE } from '../../throttler/throttler-storage.module';

// Readiness of the rate limiter, asked through the throttle storage's OWN connection (a real PING,
// or "down" while its circuit breaker is open). It is deliberately not derived from the BullMQ
// ping in RedisHealthIndicator or from the cache: either of those can be healthy while this
// connection is not (a different failure, a tripped breaker), and the other way round.
// With THROTTLE_STORAGE=memory there is nothing to check.
@Injectable()
export class ThrottleStorageHealthIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    @Inject(REDIS_THROTTLER_STORAGE) private readonly storage: RedisThrottlerStorage | null,
  ) {}

  async check<Key extends string>(key: Key): Promise<HealthIndicatorResult<Key>> {
    const session = this.healthIndicatorService.check(key);
    if (!this.storage) return session.up({ storage: 'memory' });
    // Never echo the raw client error: it can expose internal hostnames/ports.
    return (await this.storage.probe())
      ? session.up({ storage: 'redis' })
      : session.down({ storage: 'redis', reason: 'unreachable' });
  }
}
