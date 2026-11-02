import { Queue } from 'bullmq';
import { JobQueueService } from './job-queue.service';
import { QUEUE_NAMES } from './queue.constants';

const add = vi.fn();
const isPaused = vi.fn();
const on = vi.fn();
const queue = { add, isPaused, on } as unknown as Queue;
const payload = { organizationId: 'org' };

describe('JobQueueService', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it('attaches an error listener to every queue, so a Redis outage cannot crash the process', () => {
    new JobQueueService(queue);
    expect(on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('logs a queue error with a readable message even when the client sends an empty one', () => {
    const service = new JobQueueService(queue);
    const log = vi.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
    const handler = on.mock.calls[0][1] as (error: Error) => void;
    const refused = new Error('');
    refused.name = 'AggregateError';
    handler(refused);
    expect(log).toHaveBeenCalledWith('Queue notifications error: AggregateError');
  });

  it('adds the job with its id and delay', async () => {
    add.mockResolvedValue({});
    await new JobQueueService(queue).enqueue(QUEUE_NAMES.NOTIFICATIONS, 'create', payload, {
      jobId: 'k-1',
      delayMs: 500,
    });
    expect(add).toHaveBeenCalledWith('create', payload, { jobId: 'k-1', delay: 500 });
  });

  it('passes a plain add through without options', async () => {
    add.mockResolvedValue({});
    await new JobQueueService(queue).enqueue(QUEUE_NAMES.NOTIFICATIONS, 'create', payload);
    expect(add).toHaveBeenCalledWith('create', payload, { jobId: undefined, delay: undefined });
  });

  it('rejects instead of hanging when Redis never answers', async () => {
    vi.useFakeTimers();
    add.mockReturnValue(new Promise(() => undefined));
    const pending = new JobQueueService(queue).enqueue(
      QUEUE_NAMES.NOTIFICATIONS,
      'create',
      payload,
    );
    const assertion = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
  });

  it('propagates an enqueue error to the caller', async () => {
    add.mockRejectedValue(new Error('READONLY'));
    await expect(
      new JobQueueService(queue).enqueue(QUEUE_NAMES.NOTIFICATIONS, 'create', payload),
    ).rejects.toThrow('READONLY');
  });

  it('pings by reading from the queue, and rejects when Redis does not answer', async () => {
    isPaused.mockResolvedValueOnce(false);
    await expect(new JobQueueService(queue).ping()).resolves.toBeUndefined();

    vi.useFakeTimers();
    isPaused.mockReturnValueOnce(new Promise(() => undefined));
    const pending = new JobQueueService(queue).ping();
    const assertion = expect(pending).rejects.toThrow('Redis ping timed out');
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
  });
});
