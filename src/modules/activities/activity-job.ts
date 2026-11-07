import { ActivityType } from '../../generated/prisma/client';
import { TenantJobPayload } from '../../infrastructure/queue/queue.types';
import { ActivityParent } from './activity-parent';

export const CREATE_ACTIVITY_JOB = 'create-activity';

// Ids and enum values only, plus one nested object for deal data (see DEAL_METADATA_KEY).
export type ActivityMetadata = Record<string, string | null | Record<string, string>>;

// Everything the worker needs to write ONE timeline entry, already decided by the producer. JSON
// only (it travels through Redis), so the instant is an ISO string.
export interface CreateActivityJob extends TenantJobPayload {
  actorId: string | null;
  type: ActivityType;
  subject: string;
  metadata: ActivityMetadata;
  occurredAt: string;
  target: ActivityParent;
  // The business fact AND the target: one event gives one job (and one entry) per target, and a
  // redelivery of the same job hits the unique index instead of writing twice.
  dedupeKey: string;
}
