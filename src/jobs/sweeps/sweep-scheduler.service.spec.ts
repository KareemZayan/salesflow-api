import { ConfigService } from '@nestjs/config';
import { JobQueueService } from '../../infrastructure/queue/job-queue.service';
import { QUEUE_NAMES } from '../../infrastructure/queue/queue.constants';
import { SweepSchedulerService } from './sweep-scheduler.service';
import { SweepsProcessor } from './sweeps.processor';

const schedule = vi.fn();
const sweeps = {
  sweeps: [
    { name: 'a', repeat: { every: 60_000 } },
    { name: 'b', repeat: { pattern: '15 3 * * *' } },
  ],
} as unknown as SweepsProcessor;
const serviceFor = (workersEnabled: boolean) =>
  new SweepSchedulerService(
    { getOrThrow: () => ({ queue: { workersEnabled } }) } as unknown as ConfigService,
    { schedule } as unknown as JobQueueService,
    sweeps,
  );

describe('SweepSchedulerService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    schedule.mockResolvedValue(undefined);
  });

  it('upserts one scheduler per sweep on the sweeps queue', async () => {
    await serviceFor(true).onApplicationBootstrap();
    expect(schedule).toHaveBeenCalledTimes(2);
    expect(schedule).toHaveBeenCalledWith(QUEUE_NAMES.SWEEPS, 'a', { every: 60_000 }, 'a');
    expect(schedule).toHaveBeenCalledWith(QUEUE_NAMES.SWEEPS, 'b', { pattern: '15 3 * * *' }, 'b');
  });

  it('registers nothing on a producer-only instance', async () => {
    await serviceFor(false).onApplicationBootstrap();
    expect(schedule).not.toHaveBeenCalled();
  });

  it('does not stop the application when Redis is down at boot', async () => {
    schedule.mockRejectedValue(new Error('timed out'));
    const service = serviceFor(true);
    const log = vi.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(2);
  });
});
