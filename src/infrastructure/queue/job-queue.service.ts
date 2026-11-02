import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { withTimeout } from '../../common/utils/with-timeout.util';
import { QUEUE_NAMES, QueueName, REDIS_OPERATION_TIMEOUT_MS } from './queue.constants';
import { TenantJobPayload } from './queue.types';

export interface EnqueueOptions {
  // Same id = same job: while the first one is still stored, adding it again is a no-op. A
  // cheap first line of defence only; the handler's own idempotency is the real guarantee.
  jobId?: string;
  delayMs?: number;
}

// The one producer-side entry point (Adapter over BullMQ): features enqueue through this, never
// through a Queue instance, so the timeout, the options and the error handling live in one place.
@Injectable()
export class JobQueueService {
  private readonly logger = new Logger(JobQueueService.name);
  private readonly queues: Record<QueueName, Queue>;

  constructor(@InjectQueue(QUEUE_NAMES.NOTIFICATIONS) notifications: Queue) {
    this.queues = { [QUEUE_NAMES.NOTIFICATIONS]: notifications };
    // BullMQ queues are EventEmitters: an 'error' with no listener would throw inside the Redis
    // client. A Redis outage must be logged, never crash the process.
    for (const [name, queue] of Object.entries(this.queues)) {
      queue.on('error', (error) =>
        // A refused connection surfaces as an AggregateError with an empty message.
        this.logger.error(`Queue ${name} error: ${error.message || error.name}`),
      );
    }
  }

  // Rejects when Redis is unreachable (bounded by REDIS_OPERATION_TIMEOUT_MS). Callers decide
  // whether that is fatal; event listeners log it, because the business write already committed.
  async enqueue<P extends TenantJobPayload>(
    queueName: QueueName,
    jobName: string,
    payload: P,
    { jobId, delayMs }: EnqueueOptions = {},
  ): Promise<void> {
    await withTimeout(
      this.queues[queueName].add(jobName, payload, { jobId, delay: delayMs }),
      REDIS_OPERATION_TIMEOUT_MS,
      `Enqueue ${queueName}/${jobName}`,
    );
  }

  // A real round-trip to Redis through the queue connection (reads one queue flag), for
  // /health/ready. BullMQ 6 does not expose the raw client, so this is the cheapest honest probe.
  async ping(): Promise<void> {
    await withTimeout(
      this.queues[QUEUE_NAMES.NOTIFICATIONS].isPaused(),
      REDIS_OPERATION_TIMEOUT_MS,
      'Redis ping',
    );
  }
}
