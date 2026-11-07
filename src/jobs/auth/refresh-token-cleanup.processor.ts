import { Injectable } from '@nestjs/common';
import { QUEUE_NAMES } from '../../infrastructure/queue/queue.constants';
import { QueueWorkersService } from '../../infrastructure/queue/queue-workers.service';
import { RefreshTokenCleanupService } from '../../modules/auth/refresh-token-cleanup.service';
import { OrganizationJobProcessor } from '../organization-job.processor';

// Daily: deletes one organization's refresh tokens that expired long ago. Deleting nothing twice is
// still nothing, so reruns are harmless.
@Injectable()
export class RefreshTokenCleanupProcessor extends OrganizationJobProcessor {
  readonly queueName = QUEUE_NAMES.REFRESH_TOKEN_CLEANUP;

  constructor(
    private readonly cleanup: RefreshTokenCleanupService,
    workers: QueueWorkersService,
  ) {
    super(workers);
  }

  protected async run(now: Date) {
    return { deleted: await this.cleanup.purgeExpired(now) };
  }
}
