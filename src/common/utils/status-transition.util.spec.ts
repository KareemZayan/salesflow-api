import {
  TransitionMap,
  applyStatusTransition,
  isTransitionAllowed,
} from './status-transition.util';

type S = 'A' | 'B' | 'C';
const map: TransitionMap<S> = { A: ['B'], B: ['C'], C: [] };

const read = vi.fn();
const write = vi.fn();
const transition = (to: S) => ({
  map,
  to,
  read,
  write,
  notFound: () => new Error('not found'),
  rejected: (from: S, target: S) => new Error(`rejected ${from}->${target}`),
  changedConcurrently: (actual: S, target: S) => new Error(`changed ${actual}->${target}`),
});

beforeEach(() => vi.resetAllMocks());

describe('isTransitionAllowed', () => {
  it('follows the map; a status is never allowed to itself unless listed', () => {
    expect(isTransitionAllowed(map, 'A', 'B')).toBe(true);
    expect(isTransitionAllowed(map, 'A', 'C')).toBe(false);
    expect(isTransitionAllowed(map, 'A', 'A')).toBe(false);
    expect(isTransitionAllowed(map, 'C', 'A')).toBe(false);
  });
});

describe('applyStatusTransition', () => {
  it('writes with the status it just read as `from` and returns the written record', async () => {
    read.mockResolvedValue({ status: 'A' });
    write.mockResolvedValue({ status: 'B' });
    await expect(applyStatusTransition(transition('B'))).resolves.toEqual({ status: 'B' });
    expect(write).toHaveBeenCalledWith('A');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('not found when the record is not visible, without writing', async () => {
    read.mockResolvedValue(null);
    await expect(applyStatusTransition(transition('B'))).rejects.toThrow('not found');
    expect(write).not.toHaveBeenCalled();
  });

  it('rejected when the map forbids it, without writing', async () => {
    read.mockResolvedValue({ status: 'A' });
    await expect(applyStatusTransition(transition('C'))).rejects.toThrow('rejected A->C');
    await expect(applyStatusTransition(transition('A'))).rejects.toThrow('rejected A->A');
    expect(write).not.toHaveBeenCalled();
  });

  it('a lost race reports the status as it is now', async () => {
    read.mockResolvedValueOnce({ status: 'A' }).mockResolvedValueOnce({ status: 'B' });
    write.mockResolvedValue(null);
    await expect(applyStatusTransition(transition('B'))).rejects.toThrow('changed B->B');
  });

  it('a record that disappeared or became hidden during the race is not found, not a conflict', async () => {
    read.mockResolvedValueOnce({ status: 'A' }).mockResolvedValueOnce(null);
    write.mockResolvedValue(null);
    await expect(applyStatusTransition(transition('B'))).rejects.toThrow('not found');
  });
});
