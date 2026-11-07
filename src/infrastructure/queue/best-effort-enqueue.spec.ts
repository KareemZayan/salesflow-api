import { Logger } from '@nestjs/common';
import { enqueueBestEffort } from './best-effort-enqueue';

describe('enqueueBestEffort', () => {
  const logger = new Logger('test');
  const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

  beforeEach(() => vi.clearAllMocks());

  it('runs the enqueue and logs nothing on success', async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    await enqueueBestEffort(logger, 'a job (k)', enqueue);
    expect(enqueue).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
  });

  it('swallows a failure and logs what was lost with the reason', async () => {
    await expect(
      enqueueBestEffort(logger, 'a job (k)', () => Promise.reject(new Error('Redis down'))),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith('Could not enqueue a job (k): Redis down');
  });

  it('also swallows a non-Error rejection', async () => {
    await enqueueBestEffort(logger, 'a job (k)', () => Promise.reject('boom'));
    expect(error).toHaveBeenCalledWith('Could not enqueue a job (k): boom');
  });
});
