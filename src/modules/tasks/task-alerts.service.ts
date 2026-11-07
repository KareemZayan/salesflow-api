import { Injectable } from '@nestjs/common';
import { NotificationDispatcher } from '../notifications/notification-dispatcher.service';
import { CreateNotificationJob } from '../notifications/notification-job';
import { taskDueSoonJob, taskOverdueJob } from '../notifications/notification-job.factory';
import { TASK_ALERT_BATCH_LIMIT } from './tasks.constants';
import { TasksRepository } from './tasks.repository';

// A type alias, not an interface: it is returned as the job's plain counts record.
export type AlertRun = {
  // Notifications handed to the queue and marked.
  notified: number;
  // Handed to the queue, but the task changed before it could be marked (rescheduled): the new
  // state is picked up on its own, so nothing is retried.
  superseded: number;
  // The cap was hit, so more may be waiting for the next sweep.
  capped: boolean;
};

// The work behind the scheduled task jobs, for ONE organization (the tenant comes from the job
// context, as for every request). The two alerts differ only in what they read, how they build the
// notification and which marker they set, so they share one loop.
//
// Order per task: enqueue the notification, THEN set the marker. A crash in between repeats the
// enqueue on the next run, which the notification's dedupeKey turns into a no-op; the reverse order
// could lose a notification for good. An enqueue failure throws before the marker, so the task
// stays due and the job is retried.
@Injectable()
export class TaskAlertsService {
  constructor(
    private readonly repository: TasksRepository,
    private readonly dispatcher: NotificationDispatcher,
  ) {}

  async sendDueReminders(now: Date, limit = TASK_ALERT_BATCH_LIMIT): Promise<AlertRun> {
    const due = await this.repository.findDueReminders(now, limit);
    return this.notifyEach(
      due,
      limit,
      (task) => taskDueSoonJob({ ...task, taskId: task.id }),
      (task) => this.repository.markReminderSent(task, now),
    );
  }

  async sendOverdueNotices(now: Date, limit = TASK_ALERT_BATCH_LIMIT): Promise<AlertRun> {
    const overdue = await this.repository.findOverdueUnnotified(now, limit);
    return this.notifyEach(
      overdue,
      limit,
      (task) => taskOverdueJob({ ...task, taskId: task.id }),
      (task) => this.repository.markOverdueNotified(task, now),
    );
  }

  private async notifyEach<T>(
    tasks: readonly T[],
    limit: number,
    toJob: (task: T) => CreateNotificationJob,
    mark: (task: T) => Promise<boolean>,
  ): Promise<AlertRun> {
    let notified = 0;
    let superseded = 0;
    for (const task of tasks) {
      await this.dispatcher.dispatchStrict(toJob(task));
      if (await mark(task)) notified++;
      else superseded++;
    }
    return { notified, superseded, capped: tasks.length >= limit };
  }
}
