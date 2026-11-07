import { Job } from 'bullmq';
import { QueueName } from './queue.constants';

// Every job payload names its tenant: a worker has no request, so this is the only tenant identity
// it gets (CLAUDE.md section 5). It is plain JSON, so no Dates or class instances.
export interface TenantJobPayload {
  organizationId: string;
}

// How a repeatable job fires: a fixed interval, or a cron pattern (UTC) for a time of day.
export type JobRepeat = { every: number } | { pattern: string };

// A worker-side consumer of one queue. Handlers must be IDEMPOTENT: BullMQ delivers at least once
// (retries, stalled-job recovery), so running the same job twice must not repeat its effect.
export interface QueueJobHandler<P extends object = TenantJobPayload> {
  readonly queueName: QueueName;
  readonly concurrency?: number;
  // true (default): the payload must carry an organizationId and the handler runs inside that
  // tenant. false: only the cross-tenant sweeps, which look at all organizations to decide whom to
  // fan out to and touch no tenant data themselves.
  readonly tenantScoped?: boolean;
  handle(job: Job<P>): Promise<unknown>;
}
