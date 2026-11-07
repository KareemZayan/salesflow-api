import { runInBatches } from './batch.util';

describe('runInBatches', () => {
  it('sums the batches and stops when one reports nothing left', async () => {
    const step = vi
      .fn()
      .mockResolvedValueOnce({ removed: 10, exhausted: false })
      .mockResolvedValueOnce({ removed: 3, exhausted: true });
    await expect(runInBatches(step, 5)).resolves.toBe(13);
    expect(step).toHaveBeenCalledTimes(2);
  });

  it('never runs more than maxBatches steps', async () => {
    const step = vi.fn().mockResolvedValue({ removed: 1, exhausted: false });
    await expect(runInBatches(step, 3)).resolves.toBe(3);
    expect(step).toHaveBeenCalledTimes(3);
  });

  it('propagates a failing step', async () => {
    await expect(runInBatches(() => Promise.reject(new Error('db')), 3)).rejects.toThrow('db');
  });
});
