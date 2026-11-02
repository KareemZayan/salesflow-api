import { JobsOptions } from 'bullmq';

export const QUEUE_NAMES = {
  NOTIFICATIONS: 'notifications',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const QUEUE_NAME_LIST: readonly QueueName[] = Object.values(QUEUE_NAMES);

// Failed jobs are retried with exponential backoff (2s, 4s, 8s, 16s) before they are kept as
// failed. Finished jobs are trimmed by age AND count so Redis cannot grow without bound; failed
// ones live longer because somebody has to look at them.
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 60 * 60, count: 1000 },
  removeOnFail: { age: 7 * 24 * 60 * 60, count: 5000 },
};

export const DEFAULT_WORKER_CONCURRENCY = 5;

// How long enqueueing and the readiness ping wait for Redis before giving up. Without a bound,
// BullMQ waits for the connection forever, which would hang the caller during a Redis outage.
export const REDIS_OPERATION_TIMEOUT_MS = 2000;

// How long shutdown waits for running jobs to finish before the workers are closed by force.
export const WORKER_CLOSE_TIMEOUT_MS = 10_000;
