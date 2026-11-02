import { NotificationResponseDto } from './dto/notification-response.dto';
import { NotificationRecord } from './notifications.repository';

// `payload` is a JSON column; this module only ever writes a flat string map into it, so anything
// else (a row written by hand) is dropped instead of leaking an unexpected shape to clients.
function asStringMap(value: unknown): Record<string, string> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  return Object.fromEntries(entries);
}

export function toNotificationResponse(record: NotificationRecord): NotificationResponseDto {
  return { ...record, payload: asStringMap(record.payload) };
}
