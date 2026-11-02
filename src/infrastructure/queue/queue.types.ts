import { Job } from 'bullmq';
import { QueueName } from './queue.constants';

// Every job payload names its tenant: a worker has no request, so this is the only tenant identity
// it gets (CLAUDE.md section 5). It is plain JSON, so no Dates or class instances.
export interface TenantJobPayload {
  organizationId: string;
}

// A worker-side consumer of one queue. Handlers must be IDEMPOTENT: BullMQ delivers at least once
// (retries, stalled-job recovery), so running the same job twice must not repeat its effect.
export interface QueueJobHandler<P extends TenantJobPayload = TenantJobPayload> {
  readonly queueName: QueueName;
  readonly concurrency?: number;
  handle(job: Job<P>): Promise<unknown>;
}
