-- A pipeline has at most one Won stage and at most one Lost stage, and no stage is both.
-- "Exactly one" (and "always the last two positions") is kept by the pipelines service under the
-- exclusive pipeline lock; these constraints make the database refuse a second one whatever the app does.
-- Prisma cannot express partial indexes or CHECK constraints in the schema, so they live here only.
CREATE UNIQUE INDEX "PipelineStage_pipelineId_won_key" ON "PipelineStage"("pipelineId") WHERE "isWon" = true;
CREATE UNIQUE INDEX "PipelineStage_pipelineId_lost_key" ON "PipelineStage"("pipelineId") WHERE "isLost" = true;
ALTER TABLE "PipelineStage" ADD CONSTRAINT "PipelineStage_not_won_and_lost_check" CHECK (NOT ("isWon" AND "isLost"));
