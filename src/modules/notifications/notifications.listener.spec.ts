import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { DealStatus } from '../../generated/prisma/client';
import { DealsService } from '../deals/deals.service';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { NotificationsListener } from './notifications.listener';

const dispatch = vi.fn();
const findOwnerId = vi.fn();
const run = vi.fn((_org: string, fn: () => Promise<unknown>) => fn());
const listener = new NotificationsListener(
  { dispatch } as unknown as NotificationDispatcher,
  { findOwnerId } as unknown as DealsService,
  { run } as unknown as TenantContextService,
);
const at = new Date('2026-11-02T10:00:00Z');

describe('NotificationsListener', () => {
  beforeEach(() => vi.clearAllMocks());

  it('turns task.assigned into a job for the assignee', async () => {
    await listener.onTaskAssigned({
      organizationId: 'org',
      taskId: 't',
      assigneeId: 'rep',
      previousAssigneeId: null,
      actorId: 'admin',
      assignedAt: at,
    });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ userId: 'rep' }));
  });

  it('turns lead.converted into a job for the lead owner', async () => {
    await listener.onLeadConverted({
      organizationId: 'org',
      leadId: 'l',
      contactId: 'c',
      companyId: null,
      dealId: null,
      ownerId: 'rep',
      actorId: 'admin',
      convertedAt: at,
    });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ userId: 'rep' }));
  });

  const dealEvent = {
    organizationId: 'org',
    dealId: 'd',
    pipelineId: 'p',
    fromStageId: 'a',
    toStageId: 'b',
    status: DealStatus.WON,
    actorId: 'admin',
    changedAt: at,
  };

  it('reads the current deal owner inside the event tenant and notifies them', async () => {
    findOwnerId.mockResolvedValue('rep');
    await listener.onDealStageChanged(dealEvent);
    expect(run).toHaveBeenCalledWith('org', expect.any(Function));
    expect(findOwnerId).toHaveBeenCalledWith('d');
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ userId: 'rep' }));
  });

  it('notifies nobody when the deal is gone', async () => {
    findOwnerId.mockResolvedValue(null);
    await listener.onDealStageChanged(dealEvent);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
