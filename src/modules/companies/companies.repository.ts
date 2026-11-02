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
import { DealStatus, Prisma } from '../../generated/prisma/client';
import { acquireLock } from '../../infrastructure/prisma/advisory-lock';
import { OPEN_TASK_STATUSES } from '../tasks/tasks.constants';
import { PRISMA_TENANT } from '../../infrastructure/prisma/prisma.constants';
import { COMPANY_SEARCH_FIELDS, COMPANY_SORT_FIELDS } from './companies.constants';
import { ListCompaniesQueryDto } from './dto/list-companies-query.dto';

// An explicit select: the response shape is decided here, never by whatever the table gains later.
const companySelect = {
  id: true,
  name: true,
  domain: true,
  industry: true,
  phone: true,
  address: true,
  ownerId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CompanySelect;

export type CompanyRecord = Prisma.CompanyGetPayload<{ select: typeof companySelect }>;

export type NewCompanyData = Pick<
  Prisma.CompanyUncheckedCreateInput,
  'organizationId' | 'ownerId' | 'name' | 'domain' | 'industry' | 'phone' | 'address'
>;

export type CompanyChanges = Pick<
  Prisma.CompanyUncheckedUpdateInput,
  'ownerId' | 'name' | 'domain' | 'industry' | 'phone' | 'address'
>;

export type DeleteOutcome =
  'deleted' | 'not-found' | 'has-contacts' | 'has-deals' | 'has-open-tasks';

// The tenant client adds `organizationId` and `deletedAt: null` to every query below. Visibility is
// ANDed into the same `where` as the read or write itself, so "may the caller touch this row?" and
// "touch it" are ONE statement: there is no gap in which the owner can change in between.
@Injectable()
export class CompaniesRepository {
  constructor(@Inject(PRISMA_TENANT) private readonly prisma: TenantPrismaClient) {}

  async findPage(
    scope: VisibilityScope,
    query: ListCompaniesQueryDto,
  ): Promise<PaginatedResponseDto<CompanyRecord>> {
    return queryPage(query, {
      where: applyVisibility<Prisma.CompanyWhereInput>(
        {
          ownerId: query.ownerId,
          ...containsAny<Prisma.CompanyWhereInput>(query.q, COMPANY_SEARCH_FIELDS),
        },
        scope,
      ),
      sortFields: COMPANY_SORT_FIELDS,
      fallbackSort: 'createdAt',
      find: (args) => this.prisma.company.findMany({ ...args, select: companySelect }),
      count: (where) => this.prisma.company.count({ where }),
    });
  }

  // `db` lets a caller run the read inside its own transaction (contacts check the company under
  // the company lock, in the same transaction as their write).
  findVisible(
    scope: VisibilityScope,
    id: string,
    db: Pick<TenantTransactionClient, 'company'> = this.prisma,
  ): Promise<CompanyRecord | null> {
    return db.company.findFirst({
      where: applyVisibility<Prisma.CompanyWhereInput>({ id }, scope),
      select: companySelect,
    });
  }

  create(data: NewCompanyData): Promise<CompanyRecord> {
    return this.prisma.company.create({ data, select: companySelect });
  }

  // For callers that already run a transaction (lead conversion).
  createWithin(
    db: Pick<TenantTransactionClient, 'company'>,
    data: NewCompanyData,
  ): Promise<CompanyRecord> {
    return db.company.create({ data, select: companySelect });
  }

  // `null` = no such company for this caller (missing, deleted, other tenant, or not visible, or it
  // was reassigned away from the caller after they loaded it). The caller answers 404 for all.
  async updateVisible(
    scope: VisibilityScope,
    id: string,
    data: CompanyChanges,
  ): Promise<CompanyRecord | null> {
    return nullIfNotFound(
      this.prisma.company.update({
        where: { id, ...applyVisibility<Prisma.CompanyWhereInput>(undefined, scope) },
        data,
        select: companySelect,
      }),
    );
  }

  // Visibility is checked first, so a company the caller cannot see is a 404 even when it has
  // contacts (the 409 must never confirm that an invisible company exists). The contact count is
  // tenant-scoped but deliberately NOT visibility-scoped: other users' contacts block the delete
  // too. `deletedAt: null` is explicit because the tenant extension does not filter nested
  // relations (ADR 0002). Open tasks are counted like open deals (reported after them). The 'company' lock is what the contacts module takes before linking a
  // contact to this company, so a link and this delete can never interleave.
  async softDeleteIfUnused(scope: VisibilityScope, id: string): Promise<DeleteOutcome> {
    return this.prisma.$transaction(async (tx) => {
      await acquireLock(tx, 'company', id);
      const company = await tx.company.findFirst({
        where: applyVisibility<Prisma.CompanyWhereInput>({ id }, scope),
        select: {
          _count: {
            select: {
              contacts: { where: { deletedAt: null } },
              // OPEN deals only: closed ones keep just the id and do not pin the company.
              deals: { where: { deletedAt: null, status: DealStatus.OPEN } },
              // OPEN / IN_PROGRESS tasks only: finished ones keep just the id.
              tasks: { where: { status: { in: [...OPEN_TASK_STATUSES] } } },
            },
          },
        },
      });
      if (!company) return 'not-found';
      if (company._count.contacts > 0) return 'has-contacts';
      if (company._count.deals > 0) return 'has-deals';
      if (company._count.tasks > 0) return 'has-open-tasks';
      const deleted = await nullIfNotFound(
        tx.company.delete({
          where: { id, ...applyVisibility<Prisma.CompanyWhereInput>(undefined, scope) },
        }),
      );
      return deleted ? 'deleted' : 'not-found';
    });
  }
}
