import { Logger, OnModuleInit } from '@nestjs/common';
import { Job } from 'bullmq';
import { QueueName } from '../infrastructure/queue/queue.constants';
import { QueueWorkersService } from '../infrastructure/queue/queue-workers.service';
import { QueueJobHandler, TenantJobPayload } from '../infrastructure/queue/queue.types';

// Template Method for the per-organization jobs the sweeps fan out to: registration with the
// workers, the clock, and the "log the counts only when something happened" rule live here once;
// a subclass supplies the queue and `run`. The tenant context is already set by QueueWorkersService
// from `job.data.organizationId`, so `run` uses the ordinary scoped repositories.
//
// `run` must be idempotent (BullMQ delivers at least once), and it reports plain counts: they are
// the only thing logged, never ids of records or any content.
export abstract class OrganizationJobProcessor
  implements QueueJobHandler<TenantJobPayload>, OnModuleInit
{
  abstract readonly queueName: QueueName;
  protected readonly logger = new Logger(this.constructor.name);

  constructor(private readonly workers: QueueWorkersService) {}

  protected abstract run(now: Date): Promise<Record<string, number | boolean>>;

  onModuleInit(): void {
    this.workers.register(this);
  }

  async handle(job: Job<TenantJobPayload>): Promise<Record<string, number | boolean>> {
    const counts = await this.run(new Date());
    if (Object.values(counts).some((value) => value !== 0 && value !== false)) {
      this.logger.log({
        event: `${this.queueName}.done`,
        organizationId: job.data.organizationId,
        ...counts,
      });
    }
    return counts;
  }
}
