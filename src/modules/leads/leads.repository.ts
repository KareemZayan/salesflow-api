import { Inject, Injectable } from '@nestjs/common';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import {
  TenantPrismaClient,
  TenantTransactionClient,
} from '../../common/tenant/tenant-scope.extension';
import { queryPage } from '../../common/utils/pagination.util';
import { nullIfNotFound } from '../../common/utils/prisma-error.util';
import { containsAny } from '../../common/utils/search.util';
import { applyVisibility } from '../../common/visibility/ownership-filter';
import { VisibilityScope } from '../../common/visibility/visibility.types';
import { Prisma } from '../../generated/prisma/client';
import { acquireLock } from '../../infrastructure/prisma/advisory-lock';
import { PRISMA_TENANT } from '../../infrastructure/prisma/prisma.constants';
import { LEAD_SEARCH_FIELDS, LEAD_SORT_FIELDS } from './leads.constants';
import { ListLeadsQueryDto } from './dto/list-leads-query.dto';
import { LeadScoringInput, SCORING_FIELDS, ScoringField } from './scoring/lead-scoring.strategy';

// An explicit select: the response shape is decided here, never by whatever the table gains later.
const leadSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  companyName: true,
  source: true,
  status: true,
  score: true,
  notes: true,
  ownerId: true,
  convertedAt: true,
  convertedContactId: true,
  convertedDealId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.LeadSelect;

// Built from SCORING_FIELDS so the columns read for a recomputation are the list the strategy uses.
const scoringSelect = Object.fromEntries(SCORING_FIELDS.map((field) => [field, true])) as Record<
  ScoringField,
  true
>;

export type LeadRecord = Prisma.LeadGetPayload<{ select: typeof leadSelect }>;

export type NewLeadData = Pick<
  Prisma.LeadUncheckedCreateInput,
  | 'organizationId'
  | 'ownerId'
  | 'firstName'
  | 'lastName'
  | 'email'
  | 'phone'
  | 'companyName'
  | 'source'
  | 'notes'
  | 'score'
>;

// `score` is not part of the changes a caller passes: the repository sets it when `rescore` is given.
export type LeadChanges = Pick<
  Prisma.LeadUncheckedUpdateInput,
  'ownerId' | 'firstName' | 'lastName' | 'email' | 'phone' | 'companyName' | 'source' | 'notes'
>;

// Computes the new score from the lead as stored; runs inside the transaction that holds the lead's
// lock, so what it reads cannot change before the write.
export type Rescore = (current: LeadScoringInput) => number;

type LeadDb = Pick<TenantTransactionClient, 'lead'>;

// The tenant client adds `organizationId` and `deletedAt: null` to every query below. Visibility is
// ANDed into the same `where` as the read or write itself, so "may the caller touch this row?" and
// "touch it" are ONE statement.
@Injectable()
export class LeadsRepository {
  constructor(@Inject(PRISMA_TENANT) private readonly prisma: TenantPrismaClient) {}

  findPage(
    scope: VisibilityScope,
    query: ListLeadsQueryDto,
  ): Promise<PaginatedResponseDto<LeadRecord>> {
    return queryPage(query, {
      where: applyVisibility<Prisma.LeadWhereInput>(
        {
          ownerId: query.ownerId,
          status: query.status,
          source: query.source,
          ...containsAny<Prisma.LeadWhereInput>(query.q, LEAD_SEARCH_FIELDS),
        },
        scope,
      ),
      sortFields: LEAD_SORT_FIELDS,
      fallbackSort: 'createdAt',
      find: (args) => this.prisma.lead.findMany({ ...args, select: leadSelect }),
      count: (where) => this.prisma.lead.count({ where }),
    });
  }

  findVisible(scope: VisibilityScope, id: string): Promise<LeadRecord | null> {
    return this.prisma.lead.findFirst({
      where: applyVisibility<Prisma.LeadWhereInput>({ id }, scope),
      select: leadSelect,
    });
  }

  create(data: NewLeadData): Promise<LeadRecord> {
    return this.prisma.lead.create({ data, select: leadSelect });
  }

  // `null` = no such lead for this caller (missing, deleted, other tenant, not visible, or
  // reassigned away from the caller after they loaded it). The caller answers 404 for all.
  //
  // With `rescore` the score depends on the stored scoring fields merged with the changes, so it is
  // "read, compute, write": that must not interleave with another update of the same lead (two
  // requests changing different scoring fields would each compute from a stale row and the last
  // write would drop the other's points). Both take the same 'lead' lock; the read inside the
  // transaction therefore sees the previous writer's committed row. Without `rescore` nothing
  // derived is touched and there is no lock and no transaction.
  updateVisible(
    scope: VisibilityScope,
    id: string,
    changes: LeadChanges,
    rescore?: Rescore,
  ): Promise<LeadRecord | null> {
    const write = (db: LeadDb, data: LeadChanges & { score?: number }) =>
      nullIfNotFound(
        db.lead.update({
          where: { id, ...applyVisibility<Prisma.LeadWhereInput>(undefined, scope) },
          data,
          select: leadSelect,
        }),
      );
    if (!rescore) return write(this.prisma, changes);

    return this.prisma.$transaction(async (tx) => {
      await acquireLock(tx, 'lead', id);
      const current = await tx.lead.findFirst({
        where: applyVisibility<Prisma.LeadWhereInput>({ id }, scope),
        select: scoringSelect,
      });
      if (!current) return null;
      return write(tx, { ...changes, score: rescore(current) });
    });
  }

  // Soft delete (the tenant client turns `delete` into setting `deletedAt`).
  async deleteVisible(scope: VisibilityScope, id: string): Promise<boolean> {
    const deleted = await nullIfNotFound(
      this.prisma.lead.delete({
        where: { id, ...applyVisibility<Prisma.LeadWhereInput>(undefined, scope) },
        select: { id: true },
      }),
    );
    return deleted !== null;
  }
}
