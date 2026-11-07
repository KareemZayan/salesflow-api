import { Prisma } from '../../generated/prisma/client';
import { DEAL_METADATA_KEY, isManualActivityType } from './activities.constants';
import { ActivityRecord } from './activities.repository';
import { ActivityResponseDto } from './dto/activity-response.dto';

type Metadata = Record<string, unknown>;

function asObject(value: Prisma.JsonValue | null): Metadata | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
}

// The deal a system entry is about, if any (the id sits under DEAL_METADATA_KEY).
export function referencedDealId(record: Pick<ActivityRecord, 'metadata'>): string | null {
  const deal = asObject(record.metadata)?.[DEAL_METADATA_KEY];
  const dealId = typeof deal === 'object' && deal !== null ? (deal as Metadata).dealId : undefined;
  return typeof dealId === 'string' ? dealId : null;
}

// `dealVisible = false` removes the deal data (id, stages, status) and keeps the rest of the entry.
export function toActivityResponse(
  record: ActivityRecord,
  dealVisible: boolean,
): ActivityResponseDto {
  const stored = asObject(record.metadata);
  let metadata: Metadata | null = stored;
  if (stored && !dealVisible) {
    metadata = { ...stored };
    delete metadata[DEAL_METADATA_KEY];
  }
  return { ...record, metadata, isManual: isManualActivityType(record.type) };
}
