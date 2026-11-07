import { ActivityType } from '../../generated/prisma/client';

export const ACTIVITY_SUBJECT_MAX_LENGTH = 200;
// Free text can hold anything a user types (names, prices, health or legal remarks): it is length
// limited, trimmed, never logged and shown to everyone who may see the parent record (ADR 0013).
export const ACTIVITY_BODY_MAX_LENGTH = 5000;

// What a person can log. STAGE_CHANGE and SYSTEM exist only as server-written entries, so the type
// whitelist of the create endpoint IS the "manual" definition (and the delete rule uses it too).
export const MANUAL_ACTIVITY_TYPES = [
  ActivityType.CALL,
  ActivityType.EMAIL,
  ActivityType.MEETING,
  ActivityType.NOTE,
] as const satisfies readonly ActivityType[];

export type ManualActivityType = (typeof MANUAL_ACTIVITY_TYPES)[number];

export const isManualActivityType = (type: ActivityType): type is ManualActivityType =>
  (MANUAL_ACTIVITY_TYPES as readonly ActivityType[]).includes(type);

// The metadata key that holds EVERYTHING taken from a deal (id, stages, status). A timeline of
// another record shows it only to someone who can see that deal; otherwise the key is removed.
export const DEAL_METADATA_KEY = 'deal';

// Static wording of the system entries: never a name, title or amount, so a stored subject can be
// shown to anyone who may see the timeline.
export const ACTIVITY_SUBJECTS = {
  LEAD_CONVERTED: 'Lead converted',
  LEAD_STATUS_CHANGED: 'Lead status changed',
  LEAD_ASSIGNED: 'Lead assigned',
  DEAL_STAGE_CHANGED: 'Deal stage changed',
} as const;
