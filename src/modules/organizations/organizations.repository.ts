import { Inject, Injectable } from '@nestjs/common';
import { TenantPrismaClient } from '../../common/tenant/tenant-scope.extension';
import { Prisma } from '../../generated/prisma/client';
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

// Organization is the tenant root, so the scoping extension does not filter it: every query here
// is keyed by the id of the caller's own organization (taken from the JWT, never from the request).
@Injectable()
export class OrganizationsRepository {
  constructor(@Inject(PRISMA_TENANT) private readonly prisma: TenantPrismaClient) {}

  findById(id: string): Promise<OrganizationRecord | null> {
    return this.prisma.organization.findUnique({ where: { id }, select: organizationSelect });
  }

  // `updateMany` + re-read instead of `update`: a vanished organization is a clean 404, not P2025.
  async update(
    id: string,
    data: { name?: string; defaultCurrency?: string },
  ): Promise<OrganizationRecord | null> {
    const { count } = await this.prisma.organization.updateMany({ where: { id }, data });
    return count === 0 ? null : this.findById(id);
  }
}
