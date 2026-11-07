import { Prisma } from '../../generated/prisma/client';

// Raw SQL lives under infrastructure/ and nowhere else (see advisory-lock.ts).
//
// The AuditLog trigger (migration add_audit_log_event_request_id_and_immutability) rejects every
// DELETE unless this setting is 'on'. `set_config(..., true)` is SET LOCAL: the value lives until
// the end of THIS transaction and then vanishes, so a pooled connection never keeps it. Plain SET
// would outlive the transaction and leave the next request on that connection able to delete.
// Only the audit retention job calls this, inside its own transaction (ADR 0014).
export const AUDIT_RETENTION_SETTING = 'app.audit_retention';

export async function allowAuditRetentionDelete(
  tx: Pick<Prisma.TransactionClient, '$executeRaw'>,
): Promise<void> {
  await tx.$executeRaw`SELECT set_config(${AUDIT_RETENTION_SETTING}, 'on', true)`;
}
