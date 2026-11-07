/*
  Warnings:

  - Added the required column `event` to the `AuditLog` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "event" TEXT NOT NULL,
ADD COLUMN     "requestId" TEXT;

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_createdAt_idx" ON "AuditLog"("organizationId", "createdAt" DESC);

-- Append-only audit trail (ADR 0014). Application-level defence in depth, NOT protection against
-- a database administrator: a superuser can drop this trigger or set the flag below.
--   UPDATE: always rejected.
--   DELETE: rejected unless the transaction set `app.audit_retention` to 'on' with SET LOCAL
--           (set_config(..., true)); only the retention job does, and the flag disappears at the
--           end of that transaction, so a pooled connection never keeps it.
--   TRUNCATE is deliberately not blocked (the test reset helper uses it).
-- A future data migration that has to touch audit rows must DISABLE this trigger inside the
-- migration and enable it again before it ends.
CREATE FUNCTION "audit_log_reject_change"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.audit_retention', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'AuditLog is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AuditLog_append_only"
BEFORE UPDATE OR DELETE ON "AuditLog"
FOR EACH ROW EXECUTE FUNCTION "audit_log_reject_change"();
