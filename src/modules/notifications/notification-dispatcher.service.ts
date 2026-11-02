import { Injectable, Logger } from '@nestjs/common';
import { QUEUE_NAMES } from '../../infrastructure/queue/queue.constants';
import { JobQueueService } from '../../infrastructure/queue/job-queue.service';
import { CREATE_NOTIFICATION_JOB, CreateNotificationJob } from './notification-job';

// Producer side: hands a notification job to the queue. Best effort BY DESIGN: it runs after the
// business transaction has committed, so a Redis outage is logged and swallowed rather than
// failing a request whose write already succeeded. The notification is then LOST (there is no
// outbox yet; ADR 0011 records this gap). The dedupe key doubles as the BullMQ job id.
@Injectable()
export class NotificationDispatcher {
  private readonly logger = new Logger(NotificationDispatcher.name);

  constructor(private readonly queue: JobQueueService) {}

  async dispatch(job: CreateNotificationJob | null): Promise<void> {
    if (!job) return;
    try {
      await this.queue.enqueue(QUEUE_NAMES.NOTIFICATIONS, CREATE_NOTIFICATION_JOB, job, {
        jobId: job.dedupeKey,
      });
    } catch (error) {
      // Ids only (the key names the event and the record), never the title or the payload.
      this.logger.error(
        `Could not enqueue a ${job.type} notification (${job.dedupeKey}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
