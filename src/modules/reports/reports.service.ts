import { Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { OwnershipScopeService } from '../../common/visibility/ownership-scope.service';
import { VisibilityScope } from '../../common/visibility/visibility.types';
import { DealStatus, LeadSource, LeadStatus, TaskPriority } from '../../generated/prisma/client';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { PipelinesService } from '../pipelines/pipelines.service';
import {
  CurrencyTotalDto,
  LeadConversionResponseDto,
  LeadsBySourceResponseDto,
  OverdueTasksResponseDto,
  PipelineSummaryResponseDto,
  RevenueByOwnerResponseDto,
  RevenueByPeriodResponseDto,
  WinRateResponseDto,
} from './dto/report-response.dto';
import {
  PipelineSummaryQueryDto,
  ReportRangeQueryDto,
  RevenueByPeriodQueryDto,
} from './dto/report-query.dto';
import { reportCacheKey } from './report-cache-key';
import { money, ratio } from './report-math';
import { buildBuckets, resolveReportRange, ReportRange } from './report-period.util';
import { REPORT_NAMES, REPORT_TTL_SECONDS, ReportName } from './reports.constants';
import { CurrencyAggregate, ReportsRepository } from './reports.repository';

const day = (date: Date): string => date.toISOString().slice(0, 10);
const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);

const byCurrency = (a: CurrencyAggregate, b: CurrencyAggregate): number =>
  a.currency.localeCompare(b.currency);

// One entry per currency, sorted; counts stay next to the amount they belong to.
const toTotals = (rows: CurrencyAggregate[]): CurrencyTotalDto[] =>
  [...rows].sort(byCurrency).map((row) => ({
    currency: row.currency,
    amount: money(row.amount),
    dealCount: row.dealCount,
  }));

// Orchestration only: resolve the caller's scope, look in the cache, otherwise ask the repository
// and shape the answer. The shaping is deterministic JSON (strings and numbers), which is exactly
// what the cache stores, so a hit and a miss answer with the same bytes.
@Injectable()
export class ReportsService {
  constructor(
    private readonly repository: ReportsRepository,
    private readonly ownership: OwnershipScopeService,
    private readonly cache: CacheService,
    private readonly pipelines: PipelinesService,
  ) {}

  async pipelineSummary(
    actor: AuthenticatedUser,
    { pipelineId }: PipelineSummaryQueryDto,
  ): Promise<PipelineSummaryResponseDto> {
    // Resolved BEFORE the cache lookup, so the key names the real pipeline and a changed default
    // is never answered with the old one's numbers.
    const id = pipelineId ?? (await this.pipelines.defaultPipelineId());
    return this.run(actor, REPORT_NAMES.PIPELINE_SUMMARY, { pipelineId: id }, async (scope) => {
      const pipeline = await this.pipelines.get(id);
      const rows = await this.repository.dealsByStage(scope, id);
      const stages = pipeline.stages.map((stage) => {
        const stageRows = rows.filter((row) => row.stageId === stage.id);
        return {
          stageId: stage.id,
          name: stage.name,
          position: stage.position,
          probability: stage.probability,
          isWon: stage.isWon,
          isLost: stage.isLost,
          dealCount: sum(stageRows.map((row) => row.dealCount)),
          totals: toTotals(stageRows),
        };
      });
      return {
        pipeline: { id: pipeline.id, name: pipeline.name },
        dealCount: sum(stages.map((stage) => stage.dealCount)),
        stages,
      };
    });
  }

  async winRate(actor: AuthenticatedUser, query: ReportRangeQueryDto): Promise<WinRateResponseDto> {
    const range = resolveReportRange(query, new Date());
    return this.run(actor, REPORT_NAMES.WIN_RATE, rangeParams(range), async (scope) => {
      const rows = await this.repository.closedDealsByStatus(scope, range);
      const won = rows.filter((row) => row.status === DealStatus.WON);
      const lost = rows.filter((row) => row.status === DealStatus.LOST);
      const wonCount = sum(won.map((row) => row.dealCount));
      const lostCount = sum(lost.map((row) => row.dealCount));
      return {
        ...window(range),
        wonCount,
        lostCount,
        closedCount: wonCount + lostCount,
        winRate: ratio(wonCount, wonCount + lostCount),
        won: toTotals(won),
        lost: toTotals(lost),
      };
    });
  }

  async revenueByPeriod(
    actor: AuthenticatedUser,
    query: RevenueByPeriodQueryDto,
  ): Promise<RevenueByPeriodResponseDto> {
    const interval = query.interval ?? 'day';
    const range = resolveReportRange(query, new Date());
    // Validates the bucket cap too, so an oversized window is a 400 before any cache or database work.
    const buckets = buildBuckets(range, interval);
    return this.run(
      actor,
      REPORT_NAMES.REVENUE_BY_PERIOD,
      { ...rangeParams(range), interval },
      async (scope) => {
        // Sequential on purpose: at most 53 small indexed queries must not take the whole pool.
        const perBucket: CurrencyAggregate[][] = [];
        for (const { start, end } of buckets) {
          perBucket.push(await this.repository.wonRevenue(scope, { from: start, to: end }));
        }

        // Every bucket lists every currency seen in the window, so a chart has no holes and no
        // currency is ever merged into another.
        const currencies = [...new Set(perBucket.flat().map((row) => row.currency))].sort();
        const filled = buckets.map((bucket, index) => {
          const totals = currencies.map((currency) => {
            const row = perBucket[index].find((candidate) => candidate.currency === currency);
            return { currency, amount: money(row?.amount), dealCount: row?.dealCount ?? 0 };
          });
          return {
            start: day(bucket.start),
            end: day(bucket.end),
            dealCount: sum(perBucket[index].map((row) => row.dealCount)),
            totals,
          };
        });
        return {
          ...window(range),
          interval,
          currencies,
          dealCount: sum(filled.map((bucket) => bucket.dealCount)),
          buckets: filled,
        };
      },
    );
  }

  async revenueByOwner(
    actor: AuthenticatedUser,
    query: ReportRangeQueryDto,
  ): Promise<RevenueByOwnerResponseDto> {
    const range = resolveReportRange(query, new Date());
    return this.run(actor, REPORT_NAMES.REVENUE_BY_OWNER, rangeParams(range), async (scope) => {
      const rows = await this.repository.wonRevenueByOwner(scope, range);
      const ownerIds = [...new Set(rows.map((row) => row.ownerId))];
      const names = await this.repository.findUserNames(ownerIds);
      const owners = ownerIds
        .map((ownerId) => {
          const ownerRows = rows.filter((row) => row.ownerId === ownerId);
          return {
            ownerId,
            ownerName: names.get(ownerId) ?? 'Unknown user',
            dealCount: sum(ownerRows.map((row) => row.dealCount)),
            totals: toTotals(ownerRows),
          };
        })
        .sort(
          (a, b) => a.ownerName.localeCompare(b.ownerName) || a.ownerId.localeCompare(b.ownerId),
        );
      return {
        ...window(range),
        dealCount: sum(owners.map((owner) => owner.dealCount)),
        owners,
      };
    });
  }

  async leadConversion(
    actor: AuthenticatedUser,
    query: ReportRangeQueryDto,
  ): Promise<LeadConversionResponseDto> {
    const range = resolveReportRange(query, new Date());
    return this.run(actor, REPORT_NAMES.LEAD_CONVERSION, rangeParams(range), async (scope) => {
      const rows = await this.repository.leadsBySourceAndStatus(scope, range);
      const totalLeads = sum(rows.map((row) => row.leadCount));
      const convertedLeads = sum(
        rows.filter((row) => row.status === LeadStatus.CONVERTED).map((row) => row.leadCount),
      );
      return {
        ...window(range),
        totalLeads,
        convertedLeads,
        conversionRate: ratio(convertedLeads, totalLeads),
      };
    });
  }

  async leadsBySource(
    actor: AuthenticatedUser,
    query: ReportRangeQueryDto,
  ): Promise<LeadsBySourceResponseDto> {
    const range = resolveReportRange(query, new Date());
    return this.run(actor, REPORT_NAMES.LEADS_BY_SOURCE, rangeParams(range), async (scope) => {
      const rows = await this.repository.leadsBySourceAndStatus(scope, range);
      // Every source is listed, so the frontend never has to guess what a missing one means.
      const sources = Object.values(LeadSource)
        .map((source) => {
          const sourceRows = rows.filter((row) => row.source === source);
          return {
            source,
            leadCount: sum(sourceRows.map((row) => row.leadCount)),
            convertedCount: sum(
              sourceRows
                .filter((row) => row.status === LeadStatus.CONVERTED)
                .map((row) => row.leadCount),
            ),
          };
        })
        .sort((a, b) => b.leadCount - a.leadCount || a.source.localeCompare(b.source));
      return {
        ...window(range),
        totalLeads: sum(sources.map((source) => source.leadCount)),
        sources,
      };
    });
  }

  async overdueTasks(actor: AuthenticatedUser): Promise<OverdueTasksResponseDto> {
    return this.run(
      actor,
      REPORT_NAMES.OVERDUE_TASKS,
      {},
      async (scope, computedAt) => {
        // `computedAt` is both the clock "overdue" is judged against and `generatedAt`.
        const rows = await this.repository.overdueTasks(scope, computedAt);
        const assigneeIds = [...new Set(rows.map((row) => row.assigneeId))];
        const names = await this.repository.findUserNames(assigneeIds);
        const byAssignee = assigneeIds
          .map((assigneeId) => ({
            assigneeId,
            assigneeName: names.get(assigneeId) ?? 'Unknown user',
            overdueCount: sum(
              rows.filter((row) => row.assigneeId === assigneeId).map((row) => row.taskCount),
            ),
          }))
          .sort(
            (a, b) =>
              b.overdueCount - a.overdueCount ||
              a.assigneeName.localeCompare(b.assigneeName) ||
              a.assigneeId.localeCompare(b.assigneeId),
          );
        const byPriority = Object.values(TaskPriority).map((priority) => ({
          priority,
          overdueCount: sum(
            rows.filter((row) => row.priority === priority).map((row) => row.taskCount),
          ),
        }));
        return { totalOverdue: sum(rows.map((row) => row.taskCount)), byAssignee, byPriority };
      },
      REPORT_TTL_SECONDS.overdueTasks,
    );
  }

  // Scope -> key -> cache-aside. `generatedAt` is set INSIDE the cached computation, so a hit
  // returns the instant the numbers were computed, not the instant of the request.
  private async run<T extends object>(
    actor: AuthenticatedUser,
    report: ReportName,
    params: Record<string, string | undefined>,
    build: (scope: VisibilityScope, computedAt: Date) => Promise<T>,
    ttlSeconds: number = REPORT_TTL_SECONDS.standard,
  ): Promise<{ generatedAt: string } & T> {
    const scope = await this.ownership.resolve(actor);
    // The organization comes from the authenticated user, never from the request.
    const key = reportCacheKey(actor.organizationId, report, scope, params);
    return this.cache.remember(key, ttlSeconds, async () => {
      const computedAt = new Date();
      return { generatedAt: computedAt.toISOString(), ...(await build(scope, computedAt)) };
    });
  }
}

const rangeParams = ({ from, to }: ReportRange): Record<string, string> => ({
  from: from.toISOString(),
  to: to.toISOString(),
});

const window = ({ from, to }: ReportRange): { from: string; to: string } => ({
  from: day(from),
  to: day(to),
});
