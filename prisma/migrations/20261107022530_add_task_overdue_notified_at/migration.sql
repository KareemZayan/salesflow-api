-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "overdueNotifiedAt" TIMESTAMP(3);

-- The scheduled jobs look for tasks that still owe a notification. These partial indexes hold only
-- those rows, so the per-minute "is there any work?" query stays cheap however many tasks exist, and
-- a row leaves the index the moment its marker is set.
CREATE INDEX "Task_reminder_pending_idx" ON "Task"("reminderAt") WHERE "reminderSentAt" IS NULL AND "reminderAt" IS NOT NULL AND "status" IN ('OPEN', 'IN_PROGRESS');
CREATE INDEX "Task_overdue_pending_idx" ON "Task"("dueDate") WHERE "overdueNotifiedAt" IS NULL AND "dueDate" IS NOT NULL AND "status" IN ('OPEN', 'IN_PROGRESS');
