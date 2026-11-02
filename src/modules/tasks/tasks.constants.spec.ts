import { TaskStatus } from '../../generated/prisma/client';
import { isOverdue, isOpenTask, notOverdueWhere, overdueWhere } from './tasks.constants';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);

describe('isOverdue', () => {
  it('is false when the task is due exactly now (strictly before is required)', () => {
    expect(isOverdue({ status: TaskStatus.OPEN, dueDate: NOW }, NOW)).toBe(false);
  });

  it('is true one millisecond after the due instant', () => {
    expect(isOverdue({ status: TaskStatus.OPEN, dueDate: at(-1) }, NOW)).toBe(true);
  });

  it('is false for a future due date and for no due date', () => {
    expect(isOverdue({ status: TaskStatus.OPEN, dueDate: at(1) }, NOW)).toBe(false);
    expect(isOverdue({ status: TaskStatus.OPEN, dueDate: null }, NOW)).toBe(false);
  });

  it.each([TaskStatus.OPEN, TaskStatus.IN_PROGRESS])('applies to %s tasks', (status) => {
    expect(isOverdue({ status, dueDate: at(-1000) }, NOW)).toBe(true);
  });

  it.each([TaskStatus.COMPLETED, TaskStatus.CANCELLED])(
    'a %s task past its due date is not overdue',
    (status) => {
      expect(isOverdue({ status, dueDate: at(-1000) }, NOW)).toBe(false);
    },
  );
});

describe('overdue filters', () => {
  it('use the same open statuses and the same strict boundary as isOverdue', () => {
    const open = [TaskStatus.OPEN, TaskStatus.IN_PROGRESS];
    expect(overdueWhere(NOW)).toEqual({ status: { in: open }, dueDate: { lt: NOW } });
    expect(notOverdueWhere(NOW)).toEqual({
      OR: [{ status: { notIn: open } }, { dueDate: null }, { dueDate: { gte: NOW } }],
    });
  });

  it('every open status is "open" and every other one is closed', () => {
    expect(Object.values(TaskStatus).filter(isOpenTask)).toEqual(['OPEN', 'IN_PROGRESS']);
  });
});
