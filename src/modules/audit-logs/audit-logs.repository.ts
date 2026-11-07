import { Inject, Injectable } from '@nestjs/common';
import { TenantPrismaClient } from '../../common/tenant/tenant-scope.extension';
import { BatchResult, runInBatches } from '../../common/utils/batch.util';
import { KeysetPosition } from '../../common/utils/keyset-cursor.util';
import { AuditAction, Prisma } from '../../generated/prisma/client';
import { allowAuditRetentionDelete } from '../../infrastructure/prisma/audit-retention-flag';
import { PRISMA_TENANT } from '../../infrastructure/prisma/prisma.constants';
import { AUDIT_RETENTION_TX_TIMEOUT_MS } from './audit-logs.constants';

// An explicit select: the response shape is decided here, never by whatever the table gains later.
const auditLogSelect = {
  id: true,
  event: true,
  action: true,
  entityType: true,
  entityId: true,
  actorId: true,
  before: true,
  after: true,
  ipAddress: true,
  userAgent: true,
  requestId: true,
  createdAt: true,
} satisfies Prisma.AuditLogSelect;

export type AuditLogRecord = Prisma.AuditLogGetPayload<{ select: typeof auditLogSelect }>;

export interface AuditLogFilters {
  actorId?: string;
  entityType?: string;
  entityId?: string;
  action?: AuditAction;
  event?: string;
  from?: Date;
  to?: Date;
}

// Reads and the retention delete only: audit rows are WRITTEN by AuditService, inside the
// transaction of the change they describe. Runs on the tenant-scoped client, so the organization
// filter is never hand-written.
@Injectable()
export class AuditLogsRepository {
  constructor(@Inject(PRISMA_TENANT) private readonly prisma: TenantPrismaClient) {}

  // Newest first, `createdAt` then `id` (keyset: stable under inserts, constant cost per page, no
  // count). Returns `take` rows so the caller can tell whether another page exists.
  findPage(
    filters: AuditLogFilters,
    after: KeysetPosition | undefined,
    take: number,
  ): Promise<AuditLogRecord[]> {
    const { from, to, ...equal } = filters;
    return this.prisma.auditLog.findMany({
      where: {
        ...equal,
        ...((from || to) && { createdAt: { ...(from && { gte: from }), ...(to && { lte: to }) } }),
        ...(after && {
          AND: [
            {
              OR: [{ createdAt: { lt: after.at } }, { createdAt: after.at, id: { lt: after.id } }],
            },
          ],
        }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      select: auditLogSelect,
    });
  }

  // The ONLY delete of audit rows. All batches run in ONE transaction that turns the retention flag
  // on with SET LOCAL (audit-retention-flag.ts), so the flag cannot outlive it.
  purgeOlderThan(cutoff: Date, batchSize: number, maxBatches: number): Promise<number> {
    return this.prisma.$transaction(
      async (tx) => {
        await allowAuditRetentionDelete(tx);
        return runInBatches(async (): Promise<BatchResult> => {
          const expired = await tx.auditLog.findMany({
            where: { createdAt: { lt: cutoff } },
            orderBy: { createdAt: 'asc' },
            take: batchSize,
            select: { id: true },
          });
          if (expired.length === 0) return { removed: 0, exhausted: true };
          const { count } = await tx.auditLog.deleteMany({
            where: { id: { in: expired.map(({ id }) => id) } },
          });
          return { removed: count, exhausted: expired.length < batchSize };
        }, maxBatches);
      },
      { timeout: AUDIT_RETENTION_TX_TIMEOUT_MS },
    );
  }
}
