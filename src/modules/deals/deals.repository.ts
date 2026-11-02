import { Inject, Injectable } from '@nestjs/common';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import { inLocks } from '../../common/tenant/in-locks.util';
import {
  TenantPrismaClient,
  TenantTransactionClient,
} from '../../common/tenant/tenant-scope.extension';
import { queryPage } from '../../common/utils/pagination.util';
import { nullIfNotFound } from '../../common/utils/prisma-error.util';
import { containsAny } from '../../common/utils/search.util';
import { applyVisibility } from '../../common/visibility/ownership-filter';
import { VisibilityScope } from '../../common/visibility/visibility.types';
import { DealStatus, Prisma } from '../../generated/prisma/client';
import { LockRequest } from '../../infrastructure/prisma/advisory-lock';
import { PRISMA_TENANT } from '../../infrastructure/prisma/prisma.constants';
import { DEAL_HISTORY_SORT_FIELDS, DEAL_SEARCH_FIELDS, DEAL_SORT_FIELDS } from './deals.constants';
import { ListDealHistoryQueryDto } from './dto/list-deal-history-query.dto';
import { ListDealsQueryDto } from './dto/list-deals-query.dto';

// An explicit select: the response shape is decided here, never by whatever the table gains later.
const dealSelect = {
  id: true,
  title: true,
  amount: true,
  currency: true,
  expectedCloseDate: true,
  status: true,
  lostReason: true,
  closedAt: true,
  pipelineId: true,
  stageId: true,
  contactId: true,
  companyId: true,
  ownerId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.DealSelect;

// A stage-history row with the names of its stages, for display.
const historySelect = {
  id: true,
  changedAt: true,
  changedById: true,
  fromStage: { select: { id: true, name: true } },
  toStage: { select: { id: true, name: true } },
} satisfies Prisma.DealStageHistorySelect;

export type DealHistoryRecord = Prisma.DealStageHistoryGetPayload<{ select: typeof historySelect }>;
export type DealRecord = Prisma.DealGetPayload<{ select: typeof dealSelect }>;

export type NewDealData = Pick<
  Prisma.DealUncheckedCreateInput,
  | 'organizationId'
  | 'ownerId'
  | 'pipelineId'
  | 'stageId'
  | 'contactId'
  | 'companyId'
  | 'title'
  | 'amount'
  | 'currency'
  | 'expectedCloseDate'
>;

// Stage and status are deliberately absent: only a move changes them.
export type DealChanges = Pick<
  Prisma.DealUncheckedUpdateInput,
  'ownerId' | 'contactId' | 'companyId' | 'title' | 'amount' | 'currency' | 'expectedCloseDate'
>;

export type DealsTx = TenantTransactionClient;
type DealDb = Pick<DealsTx, 'deal'>;

// A closed deal is read-only: edits carry this in their where, in the same statement as the write,
// so a deal closed a moment earlier makes them match nothing (DEAL_CLOSED, decided by a re-read).
const stillOpen = { status: DealStatus.OPEN } satisfies Prisma.DealWhereInput;

// The tenant client adds `organizationId` and `deletedAt: null` to every query below. Visibility is
// ANDed into the same `where` as the read or write itself, so "may the caller touch this row?" and
// "touch it" are ONE statement.
@Injectable()
export class DealsRepository {
  constructor(@Inject(PRISMA_TENANT) private readonly prisma: TenantPrismaClient) {}

  // Check-then-write across several rows: take the locks (advisory-lock.ts: pipeline, company,
  // contact, all SHARED for deal writes), then run `work` in the same transaction.
  inLocks<T>(locks: readonly LockRequest[], work: (tx: DealsTx) => Promise<T>): Promise<T> {
    return inLocks(this.prisma, locks, work);
  }

  findPage(
    scope: VisibilityScope,
    query: ListDealsQueryDto,
  ): Promise<PaginatedResponseDto<DealRecord>> {
    return queryPage(query, {
      where: applyVisibility<Prisma.DealWhereInput>(
        {
          ownerId: query.ownerId,
          pipelineId: query.pipelineId,
          stageId: query.stageId,
          status: query.status,
          contactId: query.contactId,
          companyId: query.companyId,
          ...containsAny<Prisma.DealWhereInput>(query.q, DEAL_SEARCH_FIELDS),
        },
        scope,
      ),
      sortFields: DEAL_SORT_FIELDS,
      fallbackSort: 'createdAt',
      find: (args) => this.prisma.deal.findMany({ ...args, select: dealSelect }),
      count: (where) => this.prisma.deal.count({ where }),
    });
  }

  // The current owner of a (live) deal of the active tenant, for system consumers with no caller.
  async findOwnerId(id: string): Promise<string | null> {
    const deal = await this.prisma.deal.findFirst({ where: { id }, select: { ownerId: true } });
    return deal?.ownerId ?? null;
  }

  findVisible(
    scope: VisibilityScope,
    id: string,
    db: DealDb = this.prisma,
  ): Promise<DealRecord | null> {
    return db.deal.findFirst({
      where: applyVisibility<Prisma.DealWhereInput>({ id }, scope),
      select: dealSelect,
    });
  }

  // The deal and its first stage-history row (no previous stage) in the caller's transaction, so a
  // deal never exists without the row that says where and by whom it was placed.
  async createWithin(db: DealsTx, data: NewDealData, changedById: string): Promise<DealRecord> {
    const deal = await db.deal.create({ data, select: dealSelect });
    await this.recordStageChange(db, {
      organizationId: data.organizationId,
      dealId: deal.id,
      fromStageId: null,
      toStageId: data.stageId,
      changedById,
    });
    return deal;
  }

  // The one writer of DealStageHistory: always called in the transaction of the change it records.
  async recordStageChange(
    db: Pick<DealsTx, 'dealStageHistory'>,
    data: {
      organizationId: string;
      dealId: string;
      fromStageId: string | null;
      toStageId: string;
      changedById: string;
    },
  ): Promise<void> {
    await db.dealStageHistory.create({ data });
  }

  // The compare-and-set of a stage move: ONE conditional update that matches only while the deal is
  // still in the stage the caller read (`from`) and still visible to the caller, and that sets the
  // stage together with the outcome fields (status, closedAt, lostReason). `null` = it matched
  // nothing (moved meanwhile, deleted, hidden), and then nothing was written.
  moveStage(
    db: DealDb,
    scope: VisibilityScope,
    id: string,
    from: string,
    data: { stageId: string; status: DealStatus; closedAt: Date | null; lostReason: string | null },
  ): Promise<DealRecord | null> {
    return nullIfNotFound(
      db.deal.update({
        where: { id, stageId: from, ...applyVisibility<Prisma.DealWhereInput>(undefined, scope) },
        data,
        select: dealSelect,
      }),
    );
  }

  // The stage history of one deal, newest first. Stage names come with the rows through the
  // relations in the same select: Prisma batches each relation into ONE `IN (...)` query for the
  // whole page, so the number of statements is constant (never one lookup per row). The caller has
  // already established that the deal is visible.
  findHistoryPage(
    dealId: string,
    query: ListDealHistoryQueryDto,
  ): Promise<PaginatedResponseDto<DealHistoryRecord>> {
    return queryPage(query, {
      where: { dealId } satisfies Prisma.DealStageHistoryWhereInput,
      sortFields: DEAL_HISTORY_SORT_FIELDS,
      fallbackSort: 'changedAt',
      find: (args) =>
        this.prisma.dealStageHistory.findMany({
          ...args,
          select: historySelect,
        }),
      count: (where) => this.prisma.dealStageHistory.count({ where }),
    });
  }

  // `null` = no such editable deal for this caller (missing, deleted, other tenant, not visible,
  // reassigned away after it was loaded, or CLOSED). The service looks again, with visibility, to
  // answer 404 or DEAL_CLOSED.
  updateOpenVisible(
    scope: VisibilityScope,
    id: string,
    data: DealChanges,
    db: DealDb = this.prisma,
  ): Promise<DealRecord | null> {
    return nullIfNotFound(
      db.deal.update({
        where: { id, ...stillOpen, ...applyVisibility<Prisma.DealWhereInput>(undefined, scope) },
        data,
        select: dealSelect,
      }),
    );
  }

  // Soft delete (the tenant client turns `delete` into setting `deletedAt`); a deal of any status
  // may be deleted. `false` = nothing visible to delete.
  async deleteVisible(scope: VisibilityScope, id: string): Promise<boolean> {
    const deleted = await nullIfNotFound(
      this.prisma.deal.delete({
        where: { id, ...applyVisibility<Prisma.DealWhereInput>(undefined, scope) },
        select: { id: true },
      }),
    );
    return deleted !== null;
  }
}
