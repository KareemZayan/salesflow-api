import { Injectable } from '@nestjs/common';
import { QUEUE_NAMES } from '../../infrastructure/queue/queue.constants';
import { QueueWorkersService } from '../../infrastructure/queue/queue-workers.service';
import { TaskAlertsService } from '../../modules/tasks/task-alerts.service';
import { OrganizationJobProcessor } from '../organization-job.processor';

// Sends the TASK_OVERDUE notices for tasks that just went past their due date in one organization
// (capped per run, the next sweep continues). A task is announced once per dueDate.
@Injectable()
export class TaskOverdueProcessor extends OrganizationJobProcessor {
  readonly queueName = QUEUE_NAMES.TASK_OVERDUE;

  constructor(
    private readonly alerts: TaskAlertsService,
    workers: QueueWorkersService,
  ) {
    super(workers);
  }

  protected run(now: Date) {
    return this.alerts.sendOverdueNotices(now);
  }
}
