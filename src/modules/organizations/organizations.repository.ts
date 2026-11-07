import { Inject, Injectable } from '@nestjs/common';
import {
  TenantPrismaClient,
  TenantTransactionClient,
} from '../../common/tenant/tenant-scope.extension';
import { Prisma } from '../../generated/prisma/client';
import { acquireLock } from '../../infrastructure/prisma/advisory-lock';
import { PRISMA_TENANT } from '../../infrastructure/prisma/prisma.constants';

const organizationSelect = {
  id: true,
  name: true,
  slug: true,
  defaultCurrency: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.OrganizationSelect;

export type OrganizationRecord = Prisma.OrganizationGetPayload<{
  select: typeof organizationSelect;
}>;

export type OrganizationsTx = TenantTransactionClient;

// Organization is the tenant root, so the scoping extension does not filter it: every query here
// is keyed by the id of the caller's own organization (taken from the JWT, never from the request).
@Injectable()
export class OrganizationsRepository {
  constructor(@Inject(PRISMA_TENANT) private readonly prisma: TenantPrismaClient) {}

  // Under the organization lock (the one user and role writes take), so the audit row of an edit
  // sees the value that edit really replaced and two edits cannot interleave.
  withOrgLock<T>(organizationId: string, work: (tx: OrganizationsTx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await acquireLock(tx, 'org', organizationId);
      return work(tx);
    });
  }

  findById(id: string, db: OrganizationsTx = this.prisma): Promise<OrganizationRecord | null> {
    return db.organization.findUnique({ where: { id }, select: organizationSelect });
  }

  // `updateMany` + re-read instead of `update`: a vanished organization is a clean 404, not P2025.
  async update(
    id: string,
    data: { name?: string; defaultCurrency?: string },
    db: OrganizationsTx = this.prisma,
  ): Promise<OrganizationRecord | null> {
    const { count } = await db.organization.updateMany({ where: { id }, data });
    return count === 0 ? null : this.findById(id, db);
  }
}
