import { Injectable } from '@nestjs/common';
import { resourceNotFound } from '../../common/exceptions/resource-not-found';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { ListNotificationsQueryDto } from './dto/list-notifications-query.dto';
import {
  MarkAllReadResponseDto,
  NotificationResponseDto,
  UnreadCountResponseDto,
} from './dto/notification-response.dto';
import { CreateNotificationJob } from './notification-job';
import { toNotificationResponse } from './notifications.mapper';
import { CreateOutcome, NotificationsRepository } from './notifications.repository';

// Notifications belong to their recipient, not to a visibility scope: there is no "manager sees
// the team's inbox" rule, so every read and write below is keyed on the caller's own user id.
@Injectable()
export class NotificationsService {
  constructor(private readonly repository: NotificationsRepository) {}

  async list(
    actor: AuthenticatedUser,
    query: ListNotificationsQueryDto,
  ): Promise<PaginatedResponseDto<NotificationResponseDto>> {
    const page = await this.repository.findPage(actor.userId, query);
    return { ...page, data: page.data.map(toNotificationResponse) };
  }

  async unreadCount(actor: AuthenticatedUser): Promise<UnreadCountResponseDto> {
    return { count: await this.repository.countUnread(actor.userId) };
  }

  async markRead(actor: AuthenticatedUser, id: string): Promise<NotificationResponseDto> {
    const notification = await this.repository.markRead(actor.userId, id, new Date());
    if (!notification) throw resourceNotFound('Notification');
    return toNotificationResponse(notification);
  }

  async markAllRead(actor: AuthenticatedUser): Promise<MarkAllReadResponseDto> {
    return { updated: await this.repository.markAllRead(actor.userId, new Date()) };
  }

  // The write side of the queue job. Safe to run any number of times for the same job.
  createFromJob(job: CreateNotificationJob): Promise<CreateOutcome> {
    return this.repository.createIfAbsent(job);
  }
}
