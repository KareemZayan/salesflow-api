import { DealStatus } from '../../../generated/prisma/client';

export const DEAL_STAGE_CHANGED_EVENT = 'deal.stage_changed';

// Ids, the resulting status and the tenant only: no title, amount or personal data. A move to a Won
// or Lost stage is the same event with `status` WON / LOST (listeners decide what that means).
export interface DealStageChangedEvent {
  organizationId: string;
  dealId: string;
  pipelineId: string;
  fromStageId: string;
  toStageId: string;
  status: DealStatus;
  actorId: string;
  changedAt: Date;
}
