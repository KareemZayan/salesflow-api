import { HttpException } from '@nestjs/common';
import { DealStatus } from '../../generated/prisma/client';
import { outcomeOfMove } from './deal-move';

const now = new Date('2026-11-02T10:00:00.000Z');
const open = { isWon: false, isLost: false };
const won = { isWon: true, isLost: false };
const lost = { isWon: false, isLost: true };
const code = (fn: () => unknown): string =>
  JSON.stringify(
    (
      (() => {
        try {
          fn();
        } catch (error) {
          return error;
        }
      })() as HttpException
    ).getResponse(),
  );

describe('outcomeOfMove', () => {
  it('an open stage keeps the deal OPEN with no close date and no reason', () => {
    expect(outcomeOfMove(open, undefined, now)).toEqual({
      status: DealStatus.OPEN,
      closedAt: null,
      lostReason: null,
    });
  });

  it('the Won stage wins the deal and stamps closedAt', () => {
    expect(outcomeOfMove(won, undefined, now)).toEqual({
      status: DealStatus.WON,
      closedAt: now,
      lostReason: null,
    });
  });

  it('the Lost stage loses the deal with the reason', () => {
    expect(outcomeOfMove(lost, 'Chose a competitor', now)).toEqual({
      status: DealStatus.LOST,
      closedAt: now,
      lostReason: 'Chose a competitor',
    });
  });

  it('a Lost stage without a reason is LOST_REASON_REQUIRED', () => {
    expect(code(() => outcomeOfMove(lost, undefined, now))).toContain('LOST_REASON_REQUIRED');
  });

  it.each([
    ['an open stage', open],
    ['the Won stage', won],
  ])('a reason for %s is LOST_REASON_NOT_ALLOWED', (_label, stage) => {
    expect(code(() => outcomeOfMove(stage, 'because', now))).toContain('LOST_REASON_NOT_ALLOWED');
  });
});
