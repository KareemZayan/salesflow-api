-- AlterTable
ALTER TABLE "Activity" ADD COLUMN     "dedupeKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Activity_organizationId_dedupeKey_key" ON "Activity"("organizationId", "dedupeKey");

-- An activity belongs to a timeline: at least one of its four links must be set. Prisma cannot
-- express a CHECK, so it lives here (the schema comment points at this migration).
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_has_link_check"
  CHECK ("leadId" IS NOT NULL OR "dealId" IS NOT NULL OR "contactId" IS NOT NULL OR "companyId" IS NOT NULL);
