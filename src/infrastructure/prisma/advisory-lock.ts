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
// Lock ordering: take ONE lock per transaction. If a flow ever needs two, take them in this order:
// 'org', then 'lead', then 'company', so two transactions can never wait on each other. (Lead
// conversion, Phase 9, locks the lead first and then the company it links or creates.)
export type LockKind = 'org' | 'lead' | 'company';

export async function acquireLock(
  tx: Pick<Prisma.TransactionClient, '$executeRaw'>,
  kind: LockKind,
  id: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${kind}:${id}`}, 0))`;
}
