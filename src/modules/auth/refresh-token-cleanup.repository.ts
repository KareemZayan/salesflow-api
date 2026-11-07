import { Inject, Injectable } from '@nestjs/common';
import { TenantPrismaClient } from '../../common/tenant/tenant-scope.extension';
import { PRISMA_TENANT } from '../../infrastructure/prisma/prisma.constants';

export interface CleanupBatch {
  removed: number;
  // Id of the last row looked at: the next batch continues after it, so rows that are kept (their
  // family is alive) are not read again and again.
  lastId: string | null;
  exhausted: boolean;
}

// Runs inside a job's tenant, so the scoped client limits every query to that organization.
@Injectable()
export class RefreshTokenCleanupRepository {
  constructor(@Inject(PRISMA_TENANT) private readonly prisma: TenantPrismaClient) {}

  // Deletes the expired tokens of one batch, except those whose family still has a live token (not
  // revoked, not expired at `now`): such a family is an open session and its history stays. A
  // family with no live token can never get one back, because a new token is only issued by
  // rotating a live one, so deciding and deleting need no transaction.
  async deleteExpiredBatch(params: {
    expiredBefore: Date;
    now: Date;
    afterId: string | null;
    limit: number;
  }): Promise<CleanupBatch> {
    const { expiredBefore, now, afterId, limit } = params;
    const candidates = await this.prisma.refreshToken.findMany({
      where: { expiresAt: { lt: expiredBefore }, ...(afterId && { id: { gt: afterId } }) },
      orderBy: { id: 'asc' },
      take: limit,
      select: { id: true, familyId: true },
    });
    if (candidates.length === 0) return { removed: 0, lastId: afterId, exhausted: true };

    const live = await this.prisma.refreshToken.findMany({
      where: {
        familyId: { in: [...new Set(candidates.map(({ familyId }) => familyId))] },
        revokedAt: null,
        expiresAt: { gt: now },
      },
      distinct: ['familyId'],
      select: { familyId: true },
    });
    const liveFamilies = new Set(live.map(({ familyId }) => familyId));
    const { count } = await this.prisma.refreshToken.deleteMany({
      where: {
        id: {
          in: candidates.filter(({ familyId }) => !liveFamilies.has(familyId)).map(({ id }) => id),
        },
      },
    });
    return {
      removed: count,
      lastId: candidates[candidates.length - 1].id,
      exhausted: candidates.length < limit,
    };
  }
}
