import { Injectable } from '@nestjs/common';
import { QUEUE_NAMES } from '../../infrastructure/queue/queue.constants';
import { QueueWorkersService } from '../../infrastructure/queue/queue-workers.service';
import { AuditLogsService } from '../../modules/audit-logs/audit-logs.service';
import { OrganizationJobProcessor } from '../organization-job.processor';

// Daily: PERMANENTLY deletes one organization's audit rows past their retention (see
// AUDIT_RETENTION_DAYS). The only code that may delete audit rows; the trigger allows it only inside
// the transaction that sets the retention flag. Only the number of deleted rows is logged.
@Injectable()
export class AuditRetentionProcessor extends OrganizationJobProcessor {
  readonly queueName = QUEUE_NAMES.AUDIT_RETENTION;

  constructor(
    private readonly auditLogs: AuditLogsService,
    workers: QueueWorkersService,
  ) {
    super(workers);
  }

  protected async run(now: Date) {
    return { deleted: await this.auditLogs.purgeExpired(now) };
  }
}
