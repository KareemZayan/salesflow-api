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
import { LeadStatus, Prisma } from '../../generated/prisma/client';
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

// What a new contact and company are built from, read as part of the claim.
const conversionSourceSelect = {
  ownerId: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  companyName: true,
} satisfies Prisma.LeadSelect;

export type LeadRecord = Prisma.LeadGetPayload<{ select: typeof leadSelect }>;
export type LeadConversionSource = Prisma.LeadGetPayload<{
  select: typeof conversionSourceSelect;
}>;

// The record a conversion links to, locked for the duration of the transaction.
export interface ConversionLock {
  kind: 'company' | 'contact';
  id: string;
}

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

// A converted lead is final: edits and deletes carry this in their where, in the same statement as
// the write, so a conversion committed a moment earlier makes them match nothing.
const notConverted = { status: { not: LeadStatus.CONVERTED } } satisfies Prisma.LeadWhereInput;

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

  // `null` = no such editable lead for this caller (missing, deleted, other tenant, not visible,
  // reassigned away from the caller after they loaded it, or CONVERTED). The service looks again,
  // with visibility, to answer 404 or LEAD_ALREADY_CONVERTED.
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
          where: {
            id,
            ...notConverted,
            ...applyVisibility<Prisma.LeadWhereInput>(undefined, scope),
          },
          data,
          select: leadSelect,
        }),
      );
    if (!rescore) return write(this.prisma, changes);

    return this.prisma.$transaction(async (tx) => {
      await acquireLock(tx, 'lead', id);
      const current = await tx.lead.findFirst({
        where: applyVisibility<Prisma.LeadWhereInput>({ id, ...notConverted }, scope),
        select: scoringSelect,
      });
      if (!current) return null;
      return write(tx, { ...changes, score: rescore(current) });
    });
  }

  // The compare-and-set of a status change: matches only while the lead still has the status the
  // caller read (`from`), so a concurrent change or conversion makes it match nothing (`null`).
  // `from` must come from a server-side read, never from the request. The score is not touched: it
  // does not depend on the status (ADR 0008).
  transitionStatus(
    scope: VisibilityScope,
    id: string,
    from: LeadStatus,
    to: LeadStatus,
  ): Promise<LeadRecord | null> {
    return nullIfNotFound(
      this.prisma.lead.update({
        where: { id, status: from, ...applyVisibility<Prisma.LeadWhereInput>(undefined, scope) },
        data: { status: to },
        select: leadSelect,
      }),
    );
  }

  // The conversion: ONE transaction that
  //   1. takes the lead lock (then the lock of the company or contact being linked, in the order
  //      documented in advisory-lock.ts),
  //   2. claims the lead with a compare-and-set (`status = from` and the caller's visibility) that
  //      sets CONVERTED and returns the lead's CURRENT data, which is what `work` builds from, not a
  //      copy read earlier,
  //   3. runs `work` (creating or linking the contact and company through their services, in this
  //      same transaction), and
  //   4. records the contact on the lead.
  // `null` = the claim matched nothing (changed, hidden or deleted meanwhile); nothing was written.
  // Anything `work` throws rolls the whole transaction back, the claim included. The score and the
  // other lead fields are untouched. This method is its own path on purpose: `updateVisible` and
  // `deleteVisible` refuse converted leads.
  convert<R extends { contactId: string }>(
    scope: VisibilityScope,
    id: string,
    from: LeadStatus,
    link: ConversionLock | undefined,
    work: (tx: TenantTransactionClient, lead: LeadConversionSource) => Promise<R>,
  ): Promise<{ lead: LeadRecord; outcome: R } | null> {
    return this.prisma.$transaction(async (tx) => {
      await acquireLock(tx, 'lead', id);
      if (link) await acquireLock(tx, link.kind, link.id);

      const claimed = await nullIfNotFound(
        tx.lead.update({
          where: { id, status: from, ...applyVisibility<Prisma.LeadWhereInput>(undefined, scope) },
          data: { status: LeadStatus.CONVERTED, convertedAt: new Date() },
          select: conversionSourceSelect,
        }),
      );
      if (!claimed) return null;

      const outcome = await work(tx, claimed);
      const lead = await tx.lead.update({
        where: { id },
        data: { convertedContactId: outcome.contactId },
        select: leadSelect,
      });
      return { lead, outcome };
    });
  }

  // Soft delete (the tenant client turns `delete` into setting `deletedAt`). `false` = nothing
  // deletable (same reasons as updateVisible).
  async deleteVisible(scope: VisibilityScope, id: string): Promise<boolean> {
    const deleted = await nullIfNotFound(
      this.prisma.lead.delete({
        where: { id, ...notConverted, ...applyVisibility<Prisma.LeadWhereInput>(undefined, scope) },
        select: { id: true },
      }),
    );
    return deleted !== null;
  }
}
