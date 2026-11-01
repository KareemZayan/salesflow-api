import { Prisma } from '../../generated/prisma/client';

// Raw SQL lives here and nowhere else (ESLint allows it only under infrastructure/).
//
// One advisory lock per organization, held until the surrounding transaction ends. Use it when a
// rule spans several rows ("at least one active ADMIN", "no manager cycle") so that "check, then
// write" cannot interleave with another request. Row locks cannot do this: the rows that must not
// change concurrently are the ones the check merely reads. `hashtextextended` maps the id to the
// bigint key Postgres wants; the 'org:' prefix keeps other lock families from colliding with it.
export async function acquireOrgLock(
  tx: Pick<Prisma.TransactionClient, '$executeRaw'>,
  organizationId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`org:${organizationId}`}, 0))`;
}
