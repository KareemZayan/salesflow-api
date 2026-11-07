import { Injectable } from '@nestjs/common';
import { QUEUE_NAMES } from '../../infrastructure/queue/queue.constants';
import { QueueWorkersService } from '../../infrastructure/queue/queue-workers.service';
import { TaskAlertsService } from '../../modules/tasks/task-alerts.service';
import { OrganizationJobProcessor } from '../organization-job.processor';

// Sends the TASK_DUE_SOON reminders that came due in one organization (capped per run, the next
// sweep continues). Idempotent: see TaskAlertsService for the enqueue-then-mark order.
@Injectable()
export class TaskRemindersProcessor extends OrganizationJobProcessor {
  readonly queueName = QUEUE_NAMES.TASK_REMINDERS;

  constructor(
    private readonly alerts: TaskAlertsService,
    workers: QueueWorkersService,
  ) {
    super(workers);
  }

  protected run(now: Date) {
    return this.alerts.sendDueReminders(now);
  }
}
