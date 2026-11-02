import { NotificationType } from '../../generated/prisma/client';
import { TenantJobPayload } from '../../infrastructure/queue/queue.types';

export const CREATE_NOTIFICATION_JOB = 'create-notification';

// Everything the worker needs to write ONE notification, already decided by the producer. JSON
// only (a job travels through Redis): `data` carries ids so a client can link to the record.
export interface CreateNotificationJob extends TenantJobPayload {
  userId: string;
  type: NotificationType;
  title: string;
  body: string | null;
  data: Record<string, string>;
  // Identifies the business fact ("task X was assigned at T"), not the delivery attempt. The
  // unique index on it is what makes a retried or duplicated job harmless.
  dedupeKey: string;
}
