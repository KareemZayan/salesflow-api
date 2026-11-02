import { Inject, Injectable } from '@nestjs/common';
import { TenantPrismaClient } from '../tenant/tenant-scope.extension';
import { PRISMA_TENANT } from '../../infrastructure/prisma/prisma.constants';

@Injectable()
export class VisibilityRepository {
  constructor(@Inject(PRISMA_TENANT) private readonly prisma: TenantPrismaClient) {}

  // Direct reports only, inactive ones included: their records stay visible to the manager.
  // The scoped client keeps this inside the caller's organization.
  async findDirectReportIds(managerId: string): Promise<string[]> {
    const reports = await this.prisma.user.findMany({
      where: { managerId },
      select: { id: true },
    });
    return reports.map(({ id }) => id);
  }

  // The scoped client only sees the caller's organization, so a foreign id is simply "not found".
  async isActiveUser(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isActive: true },
    });
    return user?.isActive === true;
  }
}
