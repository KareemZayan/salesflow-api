import { Inject, Injectable } from '@nestjs/common';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import { TenantPrismaClient } from '../../common/tenant/tenant-scope.extension';
import { BatchResult } from '../../common/utils/batch.util';
import { queryPage } from '../../common/utils/pagination.util';
import { isForeignKeyViolation } from '../../common/utils/prisma-error.util';
import { Prisma } from '../../generated/prisma/client';
import { PRISMA_TENANT } from '../../infrastructure/prisma/prisma.constants';
import { CreateNotificationJob } from './notification-job';
import { ListNotificationsQueryDto } from './dto/list-notifications-query.dto';
import { NOTIFICATION_SORT_FIELDS } from './notifications.constants';

const notificationSelect = {
  id: true,
  type: true,
  title: true,
  body: true,
  payload: true,
  readAt: true,
  createdAt: true,
} satisfies Prisma.NotificationSelect;

export type NotificationRecord = Prisma.NotificationGetPayload<{
  select: typeof notificationSelect;
}>;

// created: written now. duplicate: this dedupeKey already produced a notification (a retry or a
// second delivery). unknownRecipient: the user does not exist in this organization.
export type CreateOutcome = 'created' | 'duplicate' | 'unknownRecipient';

// Every method is limited to ONE recipient (`userId`) on top of the tenant scope: a notification
// is private to the user it was created for, whatever role the caller has.
@Injectable()
export class NotificationsRepository {
  constructor(@Inject(PRISMA_TENANT) private readonly prisma: TenantPrismaClient) {}

  findPage(
    userId: string,
    query: ListNotificationsQueryDto,
  ): Promise<PaginatedResponseDto<NotificationRecord>> {
    return queryPage(query, {
      where: { userId, ...(query.unread && { readAt: null }) },
      sortFields: NOTIFICATION_SORT_FIELDS,
      fallbackSort: 'createdAt',
      find: (args) => this.prisma.notification.findMany({ ...args, select: notificationSelect }),
      count: (where) => this.prisma.notification.count({ where }),
    });
  }

  countUnread(userId: string): Promise<number> {
    return this.prisma.notification.count({ where: { userId, readAt: null } });
  }

  // Idempotent: only an unread row is touched, so a repeat keeps the first `readAt`. `null` = no
  // such notification for this user (missing, someone else's, another organization).
  async markRead(userId: string, id: string, now: Date): Promise<NotificationRecord | null> {
    await this.prisma.notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: now },
    });
    return this.prisma.notification.findFirst({
      where: { id, userId },
      select: notificationSelect,
    });
  }

  async markAllRead(userId: string, now: Date): Promise<number> {
    const { count } = await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: now },
    });
    return count;
  }

  // PERMANENT delete of up to `limit` rows older than the cutoffs: read ones (`readAt` set) by the
  // first, unread ones by the second. Ids are picked first because `deleteMany` has no LIMIT.
  async deleteExpiredBatch(
    cutoffs: { read: Date; unread: Date },
    limit: number,
  ): Promise<BatchResult> {
    const expired = await this.prisma.notification.findMany({
      where: {
        OR: [
          { readAt: { not: null }, createdAt: { lt: cutoffs.read } },
          { readAt: null, createdAt: { lt: cutoffs.unread } },
        ],
      },
      select: { id: true },
      take: limit,
    });
    if (expired.length === 0) return { removed: 0, exhausted: true };
    const { count } = await this.prisma.notification.deleteMany({
      where: { id: { in: expired.map(({ id }) => id) } },
    });
    return { removed: count, exhausted: expired.length < limit };
  }

  // ON CONFLICT DO NOTHING on (organizationId, dedupeKey): two workers racing on the same job both
  // run this statement and exactly one inserts. The foreign key (userId, organizationId) is what
  // rejects a recipient from another organization or a user that does not exist.
  async createIfAbsent(job: CreateNotificationJob): Promise<CreateOutcome> {
    try {
      const { count } = await this.prisma.notification.createMany({
        data: [
          {
            organizationId: job.organizationId,
            userId: job.userId,
            type: job.type,
            title: job.title,
            body: job.body,
            payload: job.data,
            dedupeKey: job.dedupeKey,
          },
        ],
        skipDuplicates: true,
      });
      return count === 1 ? 'created' : 'duplicate';
    } catch (error) {
      if (isForeignKeyViolation(error)) return 'unknownRecipient';
      throw error;
    }
  }
}
