import { Prisma } from '../../generated/prisma/client';

// Raw SQL lives here and nowhere else (ESLint allows it only under infrastructure/).
//
// Transaction-scoped advisory locks, keyed by (kind, id). Use one when a rule spans several rows
// ("at least one active ADMIN", "no manager cycle", "a company with contacts cannot be deleted")
// so that "check, then write" cannot interleave with another request. Row locks cannot do this:
// the rows that must not change concurrently are the ones the check merely reads.
// `hashtextextended` maps the key to the bigint Postgres wants; the `kind:` prefix keeps lock
// families from colliding. The 'org' key is exactly `org:<id>`, as it was before this helper was
// generalised, so locks taken by older code paths still exclude each other.
//
// Modes. 'exclusive' (the default) excludes everyone. 'shared' excludes only exclusive holders and
// lets other shared holders in. Use shared for the many cheap writers that merely need the guarded
// thing to stay as it is (deals placed in a pipeline, deals linked to a contact) and exclusive for
// the rare writer that changes it (stage delete/reorder, contact delete). Never take a lock in
// exclusive mode after taking the same lock shared inside one transaction: the upgrade can
// deadlock two such transactions.
//
// Lock ordering: take as few locks as possible; when a flow needs several, take them in this order,
// so two transactions can never wait on each other:
//   'org', then 'lead', then 'pipeline', then 'company', then 'contact'.
// (Lead conversion locks the lead first, then the pipeline of the deal it creates, then the
// company or contact it links.)
export type LockKind = 'org' | 'lead' | 'pipeline' | 'company' | 'contact';
export type LockMode = 'exclusive' | 'shared';

export interface LockRequest {
  kind: LockKind;
  id: string;
  mode?: LockMode;
}

type LockClient = Pick<Prisma.TransactionClient, '$executeRaw'>;

export async function acquireLock(
  tx: LockClient,
  kind: LockKind,
  id: string,
  mode: LockMode = 'exclusive',
): Promise<void> {
  const key = `${kind}:${id}`;
  if (mode === 'shared') {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`;
    return;
  }
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

// Takes the locks one after the other, in the order given: the caller lists them in the order above.
export async function acquireLocks(tx: LockClient, locks: readonly LockRequest[]): Promise<void> {
  for (const { kind, id, mode } of locks) await acquireLock(tx, kind, id, mode);
}
