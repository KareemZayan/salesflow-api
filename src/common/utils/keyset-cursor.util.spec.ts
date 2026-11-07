import { HttpException } from '@nestjs/common';
import { decodeKeysetCursor, encodeKeysetCursor } from './keyset-cursor.util';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const position = {
  at: new Date('2026-11-07T10:00:00.123Z'),
  id: '33333333-3333-4333-8333-333333333333',
};
const raw = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

function rejection(cursor: string): HttpException {
  try {
    decodeKeysetCursor(cursor, ORG);
  } catch (error) {
    return error as HttpException;
  }
  throw new Error('expected the cursor to be rejected');
}

describe('keyset cursor', () => {
  it('round-trips a position for the same organization', () => {
    expect(decodeKeysetCursor(encodeKeysetCursor(ORG, position), ORG)).toEqual(position);
  });

  it('rejects a cursor issued for another organization', () => {
    expect(rejection(encodeKeysetCursor(OTHER_ORG, position)).getResponse()).toMatchObject({
      code: 'INVALID_CURSOR',
    });
  });

  it.each([
    ['not base64 json', '%%%'],
    ['empty', ''],
    ['json null', raw(null)],
    ['a json string', raw('x')],
    ['missing fields', raw({ o: ORG })],
    ['a non-uuid id', raw({ o: ORG, t: position.at.toISOString(), i: "1' OR 1=1" })],
    ['a non-ISO date', raw({ o: ORG, t: '2026', i: position.id })],
    ['a non-string date', raw({ o: ORG, t: 5, i: position.id })],
  ])('rejects %s with 400 INVALID_CURSOR', (_name, cursor) => {
    const error = rejection(cursor);
    expect(error.getStatus()).toBe(400);
    expect(error.getResponse()).toMatchObject({ code: 'INVALID_CURSOR' });
  });
});
