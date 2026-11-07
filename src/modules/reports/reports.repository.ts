import { Inject, Injectable } from '@nestjs/common';
import { TenantPrismaClient } from '../../common/tenant/tenant-scope.extension';
import { applyVisibility } from '../../common/visibility/ownership-filter';
import { VisibilityScope } from '../../common/visibility/visibility.types';
import { DealStatus, Prisma, TaskPriority } from '../../generated/prisma/client';
import { PRISMA_TENANT } from '../../infrastructure/prisma/prisma.constants';
import { overdueWhere } from '../tasks/tasks.constants';
import { ReportRange } from './report-period.util';

// Read-only aggregates for the reports. Three rules hold for every query here:
//  - it goes through the tenant client, which adds `organizationId` (and hides soft-deleted deals and
//    leads) to groupBy exactly as to any other read;
//  - visibility is ANDed into the `where`, so the database aggregates only rows the caller may see
//    (nothing is filtered after the totals are built);
//  - the money is grouped BY CURRENCY in SQL, so two currencies are never added together.
export interface CurrencyAggregate {
  currency: string;
  dealCount: number;
  amount: Prisma.Decimal | null;
}

const inRange = ({ from, to }: ReportRange) => ({ gte: from, lt: to });

const dealVisibility = (scope: VisibilityScope, where: Prisma.DealWhereInput) =>
  applyVisibility<Prisma.DealWhereInput>(where, scope, 'ownerId');
const leadVisibility = (scope: VisibilityScope, where: Prisma.LeadWhereInput) =>
  applyVisibility<Prisma.LeadWhereInput>(where, scope, 'ownerId');
// A task's owner is its assignee (ADR 0010).
const taskVisibility = (scope: VisibilityScope, where: Prisma.TaskWhereInput) =>
  applyVisibility<Prisma.TaskWhereInput>(where, scope, 'assigneeId');

@Injectable()
export class ReportsRepository {
  constructor(@Inject(PRISMA_TENANT) private readonly prisma: TenantPrismaClient) {}

  // Every deal of one pipeline per stage and currency, whatever its status (the Won and Lost stages
  // hold the closed ones).
  async dealsByStage(
    scope: VisibilityScope,
    pipelineId: string,
  ): Promise<(CurrencyAggregate & { stageId: string })[]> {
    const rows = await this.prisma.deal.groupBy({
      by: ['stageId', 'currency'],
      where: dealVisibility(scope, { pipelineId }),
      _count: { _all: true },
      _sum: { amount: true },
    });
    return rows.map((row) => ({
      stageId: row.stageId,
      currency: row.currency,
      dealCount: row._count._all,
      amount: row._sum.amount,
    }));
  }

  // WON and LOST deals closed inside the window, per outcome and currency.
  async closedDealsByStatus(
    scope: VisibilityScope,
    range: ReportRange,
  ): Promise<(CurrencyAggregate & { status: DealStatus })[]> {
    const rows = await this.prisma.deal.groupBy({
      by: ['status', 'currency'],
      where: dealVisibility(scope, {
        status: { in: [DealStatus.WON, DealStatus.LOST] },
        closedAt: inRange(range),
      }),
      _count: { _all: true },
      _sum: { amount: true },
    });
    return rows.map((row) => ({
      status: row.status,
      currency: row.currency,
      dealCount: row._count._all,
      amount: row._sum.amount,
    }));
  }

  // Revenue = WON deals by the instant they were closed. One indexed query per period bucket
  // (organizationId, status, closedAt).
  async wonRevenue(scope: VisibilityScope, range: ReportRange): Promise<CurrencyAggregate[]> {
    const rows = await this.prisma.deal.groupBy({
      by: ['currency'],
      where: dealVisibility(scope, { status: DealStatus.WON, closedAt: inRange(range) }),
      _count: { _all: true },
      _sum: { amount: true },
    });
    return rows.map((row) => ({
      currency: row.currency,
      dealCount: row._count._all,
      amount: row._sum.amount,
    }));
  }

  async wonRevenueByOwner(
    scope: VisibilityScope,
    range: ReportRange,
  ): Promise<(CurrencyAggregate & { ownerId: string })[]> {
    const rows = await this.prisma.deal.groupBy({
      by: ['ownerId', 'currency'],
      where: dealVisibility(scope, { status: DealStatus.WON, closedAt: inRange(range) }),
      _count: { _all: true },
      _sum: { amount: true },
    });
    return rows.map((row) => ({
      ownerId: row.ownerId,
      currency: row.currency,
      dealCount: row._count._all,
      amount: row._sum.amount,
    }));
  }

  // The cohort of leads CREATED in the window, per source and current status.
  async leadsBySourceAndStatus(scope: VisibilityScope, range: ReportRange) {
    const rows = await this.prisma.lead.groupBy({
      by: ['source', 'status'],
      where: leadVisibility(scope, { createdAt: inRange(range) }),
      _count: { _all: true },
    });
    return rows.map((row) => ({
      source: row.source,
      status: row.status,
      leadCount: row._count._all,
    }));
  }

  // The same rule as the task list and the isOverdue field: `overdueWhere` (tasks.constants.ts).
  async overdueTasks(
    scope: VisibilityScope,
    now: Date,
  ): Promise<{ assigneeId: string; priority: TaskPriority; taskCount: number }[]> {
    const rows = await this.prisma.task.groupBy({
      by: ['assigneeId', 'priority'],
      where: taskVisibility(scope, overdueWhere(now)),
      _count: { _all: true },
    });
    return rows.map((row) => ({
      assigneeId: row.assigneeId,
      priority: row.priority,
      taskCount: row._count._all,
    }));
  }

  // Display names for ids that came out of an aggregate. Deactivated users are included: their
  // numbers are still in the totals.
  async findUserNames(ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, firstName: true, lastName: true },
    });
    return new Map(users.map((user) => [user.id, `${user.firstName} ${user.lastName}`]));
  }
}
