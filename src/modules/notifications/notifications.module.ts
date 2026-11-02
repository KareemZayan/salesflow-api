import { Module } from '@nestjs/common';
import { QueueModule } from '../../infrastructure/queue/queue.module';
import { DealsModule } from '../deals/deals.module';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsListener } from './notifications.listener';
import { NotificationsRepository } from './notifications.repository';
import { NotificationsService } from './notifications.service';

@Module({
  imports: [QueueModule, DealsModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationsRepository,
    NotificationDispatcher,
    NotificationsListener,
  ],
  // The queue processor (src/jobs) writes through the service; 12b's schedulers will dispatch.
  exports: [NotificationsService, NotificationDispatcher],
})
export class NotificationsModule {}
