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
import { PRISMA_TENANT } from '../../infrastructure/prisma/prisma.constants';
import { CONTACT_SEARCH_FIELDS, CONTACT_SORT_FIELDS } from './contacts.constants';
import { ListContactsQueryDto } from './dto/list-contacts-query.dto';

// An explicit select: the response shape is decided here, never by whatever the table gains later.
const contactSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  jobTitle: true,
  companyId: true,
  ownerId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ContactSelect;

export type ContactRecord = Prisma.ContactGetPayload<{ select: typeof contactSelect }>;

export type NewContactData = Pick<
  Prisma.ContactUncheckedCreateInput,
  | 'organizationId'
  | 'ownerId'
  | 'companyId'
  | 'firstName'
  | 'lastName'
  | 'email'
  | 'phone'
  | 'jobTitle'
>;

export type ContactChanges = Pick<
  Prisma.ContactUncheckedUpdateInput,
  'ownerId' | 'companyId' | 'firstName' | 'lastName' | 'email' | 'phone' | 'jobTitle'
>;

// A write that links the contact to a company. `verify` runs inside the transaction that already
// holds the company's lock (see `inCompanyLock`).
export interface CompanyLink {
  companyId: string;
  verify: (db: Pick<TenantTransactionClient, 'company'>) => Promise<void>;
}

export type DeleteOutcome = 'deleted' | 'not-found' | 'has-open-deals';

type ContactDb = Pick<TenantTransactionClient, 'contact'>;

// The tenant client adds `organizationId` and `deletedAt: null` to every query below. Visibility is
// ANDed into the same `where` as the read or write itself, so "may the caller touch this row?" and
// "touch it" are ONE statement.
@Injectable()
export class ContactsRepository {
  constructor(@Inject(PRISMA_TENANT) private readonly prisma: TenantPrismaClient) {}

  findPage(
    scope: VisibilityScope,
    query: ListContactsQueryDto,
  ): Promise<PaginatedResponseDto<ContactRecord>> {
    return queryPage(query, {
      // Filtering by the id of a company the caller cannot see is not an error: the contacts
      // below it are filtered by visibility too, so the page is simply empty.
      where: applyVisibility<Prisma.ContactWhereInput>(
        {
          ownerId: query.ownerId,
          companyId: query.companyId,
          ...containsAny<Prisma.ContactWhereInput>(query.q, CONTACT_SEARCH_FIELDS),
        },
        scope,
      ),
      sortFields: CONTACT_SORT_FIELDS,
      fallbackSort: 'createdAt',
      find: (args) => this.prisma.contact.findMany({ ...args, select: contactSelect }),
      count: (where) => this.prisma.contact.count({ where }),
    });
  }

  // `db` lets a caller run the read inside its own transaction (lead conversion checks the contact
  // under the contact lock, in the same transaction as its write).
  findVisible(
    scope: VisibilityScope,
    id: string,
    db: ContactDb = this.prisma,
  ): Promise<ContactRecord | null> {
    return db.contact.findFirst({
      where: applyVisibility<Prisma.ContactWhereInput>({ id }, scope),
      select: contactSelect,
    });
  }

  create(data: NewContactData, link?: CompanyLink): Promise<ContactRecord> {
    return this.inCompanyLock(link, (db) => db.contact.create({ data, select: contactSelect }));
  }

  // For callers that already run a transaction (lead conversion).
  createWithin(db: ContactDb, data: NewContactData): Promise<ContactRecord> {
    return db.contact.create({ data, select: contactSelect });
  }

  // `null` = no such contact for this caller (missing, deleted, other tenant, not visible, or
  // reassigned away from the caller after they loaded it). The caller answers 404 for all.
  updateVisible(
    scope: VisibilityScope,
    id: string,
    data: ContactChanges,
    link?: CompanyLink,
  ): Promise<ContactRecord | null> {
    return this.inCompanyLock(link, (db) =>
      nullIfNotFound(
        db.contact.update({
          where: { id, ...applyVisibility<Prisma.ContactWhereInput>(undefined, scope) },
          data,
          select: contactSelect,
        }),
      ),
    );
  }

  // Soft delete (the tenant client turns `delete` into setting `deletedAt`), refused while the
  // contact has OPEN deals. It takes the 'contact' lock, the one lead conversion and deal writes
  // hold while they check and link an existing contact: a link that runs first is counted here, one
  // that runs after sees the contact deleted. Visibility is checked first, so a contact the caller
  // cannot see is "not-found" even when it has deals. The count is NOT visibility-scoped (the deals
  // of other users block too), and `deletedAt` / status are explicit because the tenant client does
  // not filter nested relations (ADR 0002). Closed deals do not block: they keep only the id.
  async softDeleteIfUnused(scope: VisibilityScope, id: string): Promise<DeleteOutcome> {
    return this.prisma.$transaction(async (tx) => {
      await acquireLock(tx, 'contact', id);
      const contact = await tx.contact.findFirst({
        where: applyVisibility<Prisma.ContactWhereInput>({ id }, scope),
        select: {
          _count: { select: { deals: { where: { deletedAt: null, status: DealStatus.OPEN } } } },
        },
      });
      if (!contact) return 'not-found';
      if (contact._count.deals > 0) return 'has-open-deals';
      const deleted = await nullIfNotFound(
        tx.contact.delete({
          where: { id, ...applyVisibility<Prisma.ContactWhereInput>(undefined, scope) },
          select: { id: true },
        }),
      );
      return deleted ? 'deleted' : 'not-found';
    });
  }

  // Linking to a company is "check the company, then write" and must not interleave with the
  // company's delete (which counts its live contacts). Both sides take the SAME 'company' lock, and
  // the check and the write run INSIDE this transaction, so:
  //   1. a delete that holds the lock finishes first; our check then sees the company as deleted;
  //   2. otherwise our contact is written before the lock is released, and the delete (which counts
  //      only after it acquires the lock) sees it and answers COMPANY_HAS_CONTACTS.
  // Both conditions are required: the write must share the lock's transaction, and the delete must
  // count after taking the lock. Without a link there is no lock and no transaction.
  private async inCompanyLock<T>(
    link: CompanyLink | undefined,
    write: (db: ContactDb) => Promise<T>,
  ): Promise<T> {
    if (!link) return write(this.prisma);
    return this.prisma.$transaction(async (tx) => {
      await acquireLock(tx, 'company', link.companyId);
      await link.verify(tx);
      return write(tx);
    });
  }
}
