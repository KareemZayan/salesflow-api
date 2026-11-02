import { LockRequest, acquireLocks } from '../../infrastructure/prisma/advisory-lock';
import { TenantPrismaClient, TenantTransactionClient } from './tenant-scope.extension';

// "Take these advisory locks, in the order listed, then run `work` in the SAME transaction": the
// shape every check-then-write across several rows has (advisory-lock.ts explains the order and the
// shared / exclusive modes). A plain function so each repository keeps its own client.
export function inLocks<T>(
  prisma: TenantPrismaClient,
  locks: readonly LockRequest[],
  work: (tx: TenantTransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await acquireLocks(tx, locks);
    return work(tx);
  });
}
