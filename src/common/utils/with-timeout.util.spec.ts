import { withTimeout } from './with-timeout.util';

describe('withTimeout', () => {
  afterEach(() => vi.useRealTimers());

  it('returns the value of work that settles in time', async () => {
    await expect(withTimeout(Promise.resolve(7), 50, 'job')).resolves.toBe(7);
  });

  it('passes the work error through untouched', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 50, 'job')).rejects.toThrow('boom');
  });

  it('rejects, naming the work, when it does not settle in time', async () => {
    vi.useFakeTimers();
    const pending = withTimeout(new Promise<never>(() => undefined), 100, 'Enqueue x');
    const assertion = expect(pending).rejects.toThrow('Enqueue x timed out after 100 ms');
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });

  it('leaves no timer behind after a fast success', async () => {
    vi.useFakeTimers();
    await withTimeout(Promise.resolve(1), 10_000, 'job');
    expect(vi.getTimerCount()).toBe(0);
  });
});
