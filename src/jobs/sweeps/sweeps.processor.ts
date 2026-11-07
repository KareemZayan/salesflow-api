import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { JobQueueService } from '../../infrastructure/queue/job-queue.service';
import { QUEUE_NAMES } from '../../infrastructure/queue/queue.constants';
import { QueueWorkersService } from '../../infrastructure/queue/queue-workers.service';
import { QueueJobHandler } from '../../infrastructure/queue/queue.types';
import { OrganizationWorkRepository } from '../bootstrap/organization-work.repository';
import {
  OrganizationSweep,
  SWEEP_MAX_PAGES,
  SWEEP_PAGE_SIZE,
  buildOrganizationSweeps,
} from './organization-sweeps';

// The cross-tenant consumer of the `sweeps` queue (`tenantScoped: false`: it has no organization).
// A run is a repeatable job named after its sweep; it fans out one tenant job per organization with
// work. Idempotent and self-healing: the per-organization jobId contains the time bucket, so a
// repeated or overlapping sweep adds nothing new, and if this run dies midway the jobs already
// enqueued keep running while the next tick enqueues the rest.
@Injectable()
export class SweepsProcessor implements QueueJobHandler<object>, OnModuleInit {
  readonly queueName = QUEUE_NAMES.SWEEPS;
  readonly tenantScoped = false;
  // One sweep at a time per process; they are cheap and must not race each other.
  readonly concurrency = 1;
  private readonly logger = new Logger(SweepsProcessor.name);
  readonly sweeps: readonly OrganizationSweep[];

  constructor(
    work: OrganizationWorkRepository,
    private readonly queue: JobQueueService,
    private readonly workers: QueueWorkersService,
  ) {
    this.sweeps = buildOrganizationSweeps(work);
  }

  onModuleInit(): void {
    this.workers.register(this);
  }

  async handle(job: Job<object>): Promise<number> {
    const sweep = this.sweeps.find(({ name }) => name === job.name);
    if (!sweep) throw new UnrecoverableError(`Unknown sweep ${job.name}`);
    return this.run(sweep, new Date());
  }

  // `now` is a parameter so tests can step through time buckets.
  async run(sweep: OrganizationSweep, now: Date): Promise<number> {
    const bucket = Math.floor(now.getTime() / sweep.bucketMs);
    let enqueued = 0;
    let failed = 0;
    let after: string | null = null;
    for (let page = 0; page < SWEEP_MAX_PAGES; page++) {
      const ids = await sweep.organizationIds(now, after, SWEEP_PAGE_SIZE);
      // One failed enqueue must not stop the others: settle all, count, and report at the end.
      const results = await Promise.allSettled(
        ids.map((organizationId) =>
          this.queue.enqueue(
            sweep.targetQueue,
            sweep.name,
            { organizationId },
            { jobId: `${sweep.name}-${organizationId}-${bucket}` },
          ),
        ),
      );
      failed += results.filter(({ status }) => status === 'rejected').length;
      enqueued += results.length;
      if (ids.length < SWEEP_PAGE_SIZE) break;
      after = ids[ids.length - 1];
    }
    // Idle ticks stay silent. Counts only: no organization ids in the log.
    if (enqueued > 0) this.logger.log({ event: 'sweep.done', sweep: sweep.name, enqueued, failed });
    if (failed > 0) {
      throw new Error(`Sweep ${sweep.name}: ${failed} organization job(s) could not be enqueued`);
    }
    return enqueued;
  }
}
