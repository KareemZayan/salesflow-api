import { HttpStatus } from '@nestjs/common';
import { ERROR_CODES } from '../constants/error-codes';
import { DomainException } from '../exceptions/domain.exception';

// Where the previous page ended: the sort instant and the id that breaks ties.
export interface KeysetPosition {
  at: Date;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const invalidCursor = () =>
  new DomainException(
    ERROR_CODES.INVALID_CURSOR,
    'The cursor is not valid',
    HttpStatus.BAD_REQUEST,
  );

// Opaque to the client (base64url JSON) but not secret: it only says "continue after this row of
// this organization". The organization is inside it so a cursor can never be replayed against
// another tenant. Editing it to another position of the SAME organization only moves the page
// window over rows the caller may read anyway, so it needs no signature.
export function encodeKeysetCursor(organizationId: string, { at, id }: KeysetPosition): string {
  return Buffer.from(JSON.stringify({ o: organizationId, t: at.toISOString(), i: id })).toString(
    'base64url',
  );
}

// Anything that is not exactly what encodeKeysetCursor produced for THIS organization is a 400.
export function decodeKeysetCursor(cursor: string, organizationId: string): KeysetPosition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  if (typeof parsed !== 'object' || parsed === null) throw invalidCursor();
  const { o, t, i } = parsed as Record<string, unknown>;
  if (o !== organizationId) throw invalidCursor();
  if (typeof t !== 'string' || typeof i !== 'string' || !UUID.test(i)) throw invalidCursor();
  const at = new Date(t);
  // Round-trip check rejects strings `Date` would guess at ("2026", "12/12/2026").
  if (Number.isNaN(at.getTime()) || at.toISOString() !== t) throw invalidCursor();
  return { at, id: i };
}
