import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_NAMES } from '../../infrastructure/queue/queue.constants';
import { QueueWorkersService } from '../../infrastructure/queue/queue-workers.service';
import { QueueJobHandler } from '../../infrastructure/queue/queue.types';
import { CreateOutcome } from '../../modules/activities/activities.repository';
import { ActivitiesService } from '../../modules/activities/activities.service';
import { CreateActivityJob } from '../../modules/activities/activity-job';

// Idempotent: the insert is keyed on `dedupeKey`, so BullMQ redelivering the job (retry after a
// crash, stalled-job recovery) or two workers taking the same one produce a single entry. The
// tenant context is already set by QueueWorkersService from `job.data.organizationId`; the write
// goes through the tenant-scoped client and the composite foreign keys, so a payload that names a
// record of ANOTHER organization is rejected by the database, not written.
@Injectable()
export class ActivitiesProcessor implements QueueJobHandler<CreateActivityJob>, OnModuleInit {
  readonly queueName = QUEUE_NAMES.ACTIVITIES;
  private readonly logger = new Logger(ActivitiesProcessor.name);

  constructor(
    private readonly activities: ActivitiesService,
    private readonly workers: QueueWorkersService,
  ) {}

  onModuleInit(): void {
    this.workers.register(this);
  }

  // Errors propagate on purpose: BullMQ then retries with backoff. A target that does not exist is
  // NOT an error (retrying cannot fix it), so it completes as skipped.
  async handle(job: Job<CreateActivityJob>): Promise<CreateOutcome> {
    const outcome = await this.activities.createFromJob(job.data);
    if (outcome === 'unknownTarget') {
      this.logger.warn(`Skipped activity (${job.data.dedupeKey}): no such record`);
    }
    return outcome;
  }
}
