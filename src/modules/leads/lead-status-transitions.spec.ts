import { isTransitionAllowed } from '../../common/utils/status-transition.util';
import { LeadStatus } from '../../generated/prisma/client';
import { LEAD_STATUS_TRANSITIONS, SETTABLE_LEAD_STATUSES } from './lead-status-transitions';

const { NEW, CONTACTED, QUALIFIED, UNQUALIFIED, CONVERTED } = LeadStatus;

describe('LEAD_STATUS_TRANSITIONS', () => {
  const expected: Record<LeadStatus, LeadStatus[]> = {
    NEW: [CONTACTED, UNQUALIFIED],
    CONTACTED: [QUALIFIED, UNQUALIFIED],
    QUALIFIED: [UNQUALIFIED],
    UNQUALIFIED: [CONTACTED],
    CONVERTED: [],
  };

  it.each(Object.values(LeadStatus))('%s allows exactly the documented targets', (from) => {
    for (const to of Object.values(LeadStatus)) {
      expect(isTransitionAllowed(LEAD_STATUS_TRANSITIONS, from, to)).toBe(
        expected[from].includes(to),
      );
    }
  });

  it('nothing leads to CONVERTED and CONVERTED leads nowhere', () => {
    for (const targets of Object.values(LEAD_STATUS_TRANSITIONS)) {
      expect(targets).not.toContain(CONVERTED);
    }
    expect(LEAD_STATUS_TRANSITIONS[CONVERTED]).toEqual([]);
  });

  it('a reopened lead goes back to CONTACTED, not NEW or QUALIFIED', () => {
    expect(LEAD_STATUS_TRANSITIONS[UNQUALIFIED]).toEqual([CONTACTED]);
  });

  it('a client may ask for every status except CONVERTED', () => {
    expect([...SETTABLE_LEAD_STATUSES].sort()).toEqual(
      [NEW, CONTACTED, QUALIFIED, UNQUALIFIED].sort(),
    );
  });
});
