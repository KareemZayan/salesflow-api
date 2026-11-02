import { DealStatus } from '../../generated/prisma/client';
import { lostReasonNotAllowed, lostReasonRequired } from './deals.exceptions';

export interface MoveOutcome {
  status: DealStatus;
  closedAt: Date | null;
  lostReason: string | null;
}

// What a move to `stage` does to the deal's outcome fields (pure). The status FOLLOWS the stage:
// Won -> WON, Lost -> LOST (a reason is required), any open stage -> OPEN, which is also how a
// closed deal is reopened: closedAt and lostReason are cleared, and the history keeps the story.
export function outcomeOfMove(
  stage: { isWon: boolean; isLost: boolean },
  lostReason: string | undefined,
  now: Date,
): MoveOutcome {
  if (stage.isLost) {
    if (!lostReason) throw lostReasonRequired();
    return { status: DealStatus.LOST, closedAt: now, lostReason };
  }
  if (lostReason !== undefined) throw lostReasonNotAllowed();
  if (stage.isWon) return { status: DealStatus.WON, closedAt: now, lostReason: null };
  return { status: DealStatus.OPEN, closedAt: null, lostReason: null };
}
