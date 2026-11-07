import { Injectable } from '@nestjs/common';
import { QUEUE_NAMES } from '../../infrastructure/queue/queue.constants';
import { QueueWorkersService } from '../../infrastructure/queue/queue-workers.service';
import { NotificationsService } from '../../modules/notifications/notifications.service';
import { OrganizationJobProcessor } from '../organization-job.processor';

// Daily: PERMANENTLY deletes one organization's notifications past their retention (see
// NOTIFICATION_RETENTION_DAYS). Only the number of deleted rows is logged, never their content.
@Injectable()
export class NotificationRetentionProcessor extends OrganizationJobProcessor {
  readonly queueName = QUEUE_NAMES.NOTIFICATION_RETENTION;

  constructor(
    private readonly notifications: NotificationsService,
    workers: QueueWorkersService,
  ) {
    super(workers);
  }

  protected async run(now: Date) {
    return { deleted: await this.notifications.purgeExpired(now) };
  }
}
