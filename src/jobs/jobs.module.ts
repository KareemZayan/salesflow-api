import { Module } from '@nestjs/common';
import { QueueModule } from '../infrastructure/queue/queue.module';
import { AuthModule } from '../modules/auth/auth.module';
import { NotificationsModule } from '../modules/notifications/notifications.module';
import { TasksModule } from '../modules/tasks/tasks.module';
import { RefreshTokenCleanupProcessor } from './auth/refresh-token-cleanup.processor';
import { OrganizationWorkRepository } from './bootstrap/organization-work.repository';
import { NotificationRetentionProcessor } from './notifications/notification-retention.processor';
import { NotificationsProcessor } from './notifications/notifications.processor';
import { SweepSchedulerService } from './sweeps/sweep-scheduler.service';
import { SweepsProcessor } from './sweeps/sweeps.processor';
import { TaskOverdueProcessor } from './tasks/task-overdue.processor';
import { TaskRemindersProcessor } from './tasks/task-reminders.processor';

// Worker-side consumers, grouped by domain. Each processor registers itself with the queue
// infrastructure; whether workers actually run is decided by QUEUE_WORKERS_ENABLED.
@Module({
  imports: [QueueModule, NotificationsModule, TasksModule, AuthModule],
  providers: [
    OrganizationWorkRepository,
    NotificationsProcessor,
    SweepsProcessor,
    SweepSchedulerService,
    TaskRemindersProcessor,
    TaskOverdueProcessor,
    RefreshTokenCleanupProcessor,
    NotificationRetentionProcessor,
  ],
})
export class JobsModule {}
