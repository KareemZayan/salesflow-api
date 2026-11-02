import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_NAMES } from '../../infrastructure/queue/queue.constants';
import { QueueWorkersService } from '../../infrastructure/queue/queue-workers.service';
import { QueueJobHandler } from '../../infrastructure/queue/queue.types';
import { CreateNotificationJob } from '../../modules/notifications/notification-job';
import { NotificationsService } from '../../modules/notifications/notifications.service';
import { CreateOutcome } from '../../modules/notifications/notifications.repository';

// Idempotent: the insert is keyed on `dedupeKey`, so BullMQ redelivering the job (retry after a
// crash, stalled-job recovery) or two workers taking the same one produce a single notification.
// The tenant context is already set by QueueWorkersService from `job.data.organizationId`.
@Injectable()
export class NotificationsProcessor
  implements QueueJobHandler<CreateNotificationJob>, OnModuleInit
{
  readonly queueName = QUEUE_NAMES.NOTIFICATIONS;
  private readonly logger = new Logger(NotificationsProcessor.name);

  constructor(
    private readonly notifications: NotificationsService,
    private readonly workers: QueueWorkersService,
  ) {}

  onModuleInit(): void {
    this.workers.register(this);
  }

  // Errors propagate on purpose: BullMQ then retries with backoff. A recipient that does not exist
  // is NOT an error (retrying cannot fix it), so it completes as skipped.
  async handle(job: Job<CreateNotificationJob>): Promise<CreateOutcome> {
    const outcome = await this.notifications.createFromJob(job.data);
    if (outcome === 'unknownRecipient') {
      this.logger.warn(
        `Skipped ${job.data.type} notification (${job.data.dedupeKey}): no such user`,
      );
    }
    return outcome;
  }
}
