import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { OPEN_TASK_STATUSES } from '../../modules/tasks/tasks.constants';

// The cross-tenant questions the sweeps ask: "which organizations have work?". This is the one
// place the scheduled jobs use the unscoped client (see ESLint UNSCOPED_ALLOWED), because a sweep
// has no tenant yet; it reads organization ids only and never touches tenant rows. The work itself
// runs per organization through the scoped client.
//
// Every question skips INACTIVE organizations and is keyset-paged by organization id (`after`), so
// the caller can walk all of them in bounded pages.
@Injectable()
export class OrganizationWorkRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Open tasks with a reminder due and not sent yet. Served by the partial index
  // Task_reminder_pending_idx, so this is cheap when there is nothing to do.
  withDueReminders(now: Date, after: string | null, limit: number): Promise<string[]> {
    return this.taskOrganizations({ reminderSentAt: null, reminderAt: { lte: now } }, after, limit);
  }

  // Open tasks past their due date that were not announced yet (Task_overdue_pending_idx).
  withUnnotifiedOverdueTasks(now: Date, after: string | null, limit: number): Promise<string[]> {
    return this.taskOrganizations({ overdueNotifiedAt: null, dueDate: { lt: now } }, after, limit);
  }

  // Housekeeping runs daily for everybody: one job per active organization costs less than a
  // table scan to find out who might have something to delete.
  async allActive(after: string | null, limit: number): Promise<string[]> {
    const rows = await this.prisma.organization.findMany({
      where: { isActive: true, ...(after && { id: { gt: after } }) },
      orderBy: { id: 'asc' },
      take: limit,
      select: { id: true },
    });
    return rows.map(({ id }) => id);
  }

  private async taskOrganizations(
    pending: Prisma.TaskWhereInput,
    after: string | null,
    limit: number,
  ): Promise<string[]> {
    const groups = await this.prisma.task.groupBy({
      by: ['organizationId'],
      where: {
        ...pending,
        status: { in: [...OPEN_TASK_STATUSES] },
        organization: { isActive: true },
        ...(after && { organizationId: { gt: after } }),
      },
      orderBy: { organizationId: 'asc' },
      take: limit,
    });
    return groups.map(({ organizationId }) => organizationId);
  }
}
