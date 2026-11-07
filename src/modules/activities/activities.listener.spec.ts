import { Logger } from '@nestjs/common';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { JobQueueService } from '../../infrastructure/queue/job-queue.service';
import { QUEUE_NAMES } from '../../infrastructure/queue/queue.constants';
import { DealStatus } from '../../generated/prisma/client';
import { DealsService } from '../deals/deals.service';
import { ActivitiesListener } from './activities.listener';
import { CREATE_ACTIVITY_JOB } from './activity-job';

const enqueue = vi.fn();
const findParties = vi.fn();
const run = vi.fn((_org: string, fn: () => Promise<unknown>) => fn());
const listener = new ActivitiesListener(
  { enqueue } as unknown as JobQueueService,
  { findParties } as unknown as DealsService,
  { run } as unknown as TenantContextService,
);
const at = new Date('2026-11-07T10:00:00.000Z');
const stageChanged = {
  organizationId: 'org',
  dealId: 'deal',
  pipelineId: 'p',
  fromStageId: 's1',
  toStageId: 's2',
  status: DealStatus.OPEN,
  actorId: 'actor',
  changedAt: at,
};

beforeEach(() => {
  vi.clearAllMocks();
  enqueue.mockResolvedValue(undefined);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

describe('ActivitiesListener', () => {
  it('enqueues one job per target on the activities queue, keyed by its dedupe key', async () => {
    findParties.mockResolvedValue({ contactId: 'c', companyId: 'co' });
    await listener.onDealStageChanged(stageChanged);

    expect(enqueue).toHaveBeenCalledTimes(3);
    for (const [queue, name, job, options] of enqueue.mock.calls) {
      expect(queue).toBe(QUEUE_NAMES.ACTIVITIES);
      expect(name).toBe(CREATE_ACTIVITY_JOB);
      expect(options).toEqual({ jobId: job.dedupeKey });
    }
  });

  it('reads the deal parties inside the tenant of the event', async () => {
    findParties.mockResolvedValue(null);
    await listener.onDealStageChanged(stageChanged);
    expect(run).toHaveBeenCalledWith('org', expect.any(Function));
    expect(findParties).toHaveBeenCalledWith('deal');
  });

  it('a deleted deal (no parties) still gets its own entry', async () => {
    findParties.mockResolvedValue(null);
    await listener.onDealStageChanged(stageChanged);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][2].target).toEqual({ kind: 'deal', id: 'deal' });
  });

  it('one failed enqueue does not stop the other targets, and never throws', async () => {
    findParties.mockResolvedValue({ contactId: 'c', companyId: 'co' });
    enqueue.mockRejectedValueOnce(new Error('Redis down'));
    await expect(listener.onDealStageChanged(stageChanged)).resolves.toBeUndefined();
    expect(enqueue).toHaveBeenCalledTimes(3);
  });

  it('logs the dedupe key of a lost entry but never its content', async () => {
    enqueue.mockRejectedValue(new Error('Redis down'));
    await listener.onLeadStatusChanged({
      organizationId: 'org',
      leadId: 'lead',
      from: 'NEW',
      to: 'CONTACTED',
      actorId: 'actor',
      changedAt: at,
    });
    const message = String(vi.mocked(Logger.prototype.error).mock.calls[0][0]);
    expect(message).toContain('lead.status_changed-lead-');
    expect(message).not.toContain('Lead status changed');
  });
});
