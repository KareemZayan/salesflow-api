import { Injectable } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { JobQueueService } from '../../queue/job-queue.service';

// A real PING through the BullMQ connection, so readiness proves the thing the queues need (not
// just an open port). Bounded by REDIS_OPERATION_TIMEOUT_MS inside `ping`.
@Injectable()
export class RedisHealthIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    private readonly queue: JobQueueService,
  ) {}

  async check<Key extends string>(key: Key): Promise<HealthIndicatorResult<Key>> {
    const session = this.healthIndicatorService.check(key);
    try {
      await this.queue.ping();
      return session.up();
    } catch {
      // Never echo the raw client error: it can expose internal hostnames/ports.
      return session.down('unreachable');
    }
  }
}
