import { Module } from '@nestjs/common';
import { QueueModule } from '../infrastructure/queue/queue.module';
import { NotificationsModule } from '../modules/notifications/notifications.module';
import { NotificationsProcessor } from './notifications/notifications.processor';

// Worker-side consumers, grouped by domain. Each processor registers itself with the queue
// infrastructure; whether workers actually run is decided by QUEUE_WORKERS_ENABLED.
@Module({
  imports: [QueueModule, NotificationsModule],
  providers: [NotificationsProcessor],
})
export class JobsModule {}
