import { isTransitionAllowed } from '../../common/utils/status-transition.util';
import { TaskStatus } from '../../generated/prisma/client';
import { TASK_STATUS_TRANSITIONS } from './task-status-transitions';

const { OPEN, IN_PROGRESS, COMPLETED, CANCELLED } = TaskStatus;

describe('TASK_STATUS_TRANSITIONS', () => {
  const expected: Record<TaskStatus, TaskStatus[]> = {
    OPEN: [IN_PROGRESS, COMPLETED, CANCELLED],
    IN_PROGRESS: [OPEN, COMPLETED, CANCELLED],
    COMPLETED: [OPEN],
    CANCELLED: [OPEN],
  };

  it.each(Object.values(TaskStatus))('%s allows exactly the documented targets', (from) => {
    for (const to of Object.values(TaskStatus)) {
      expect(isTransitionAllowed(TASK_STATUS_TRANSITIONS, from, to)).toBe(
        expected[from].includes(to),
      );
    }
  });

  it('no status leads to itself', () => {
    for (const status of Object.values(TaskStatus)) {
      expect(TASK_STATUS_TRANSITIONS[status]).not.toContain(status);
    }
  });

  it('a closed task can only be reopened', () => {
    expect(TASK_STATUS_TRANSITIONS[COMPLETED]).toEqual([OPEN]);
    expect(TASK_STATUS_TRANSITIONS[CANCELLED]).toEqual([OPEN]);
  });
});
