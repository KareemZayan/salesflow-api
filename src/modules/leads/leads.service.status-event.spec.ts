import { HttpException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { OwnershipScopeService } from '../../common/visibility/ownership-scope.service';
import { LeadSource, LeadStatus } from '../../generated/prisma/client';
import { LeadRecord, LeadsRepository } from './leads.repository';
import { LeadsService } from './leads.service';
import { LeadScoringStrategy } from './scoring/lead-scoring.strategy';

// Separate from leads.service.spec.ts on purpose: the 8b spec stays exactly as it was, and this file
// only pins the lead.status_changed event (Phase 13a).
const repository = { findVisible: vi.fn(), transitionStatus: vi.fn() };
const ownership = { resolve: vi.fn() };
const emitAsync = vi.fn();
const service = new LeadsService(
  repository as unknown as LeadsRepository,
  ownership as unknown as OwnershipScopeService,
  { score: vi.fn() } as LeadScoringStrategy,
  { emitAsync } as unknown as EventEmitter2,
);

const actor: AuthenticatedUser = {
  userId: 'me',
  organizationId: 'org',
  role: 'SALES_REP',
  permissions: [],
  mustChangePassword: false,
};
const lead = (status: LeadStatus): LeadRecord => ({
  id: 'l1',
  firstName: 'Omar',
  lastName: 'Khaled',
  email: null,
  phone: null,
  companyName: null,
  source: LeadSource.WEBSITE,
  status,
  score: 30,
  notes: null,
  ownerId: 'me',
  convertedAt: null,
  convertedContactId: null,
  convertedDealId: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});
const statusEvents = () =>
  emitAsync.mock.calls.filter(([name]) => name === 'lead.status_changed') as [string, object][];

beforeEach(() => {
  vi.resetAllMocks();
  ownership.resolve.mockResolvedValue({ kind: 'owners', ownerIds: ['me'] });
  emitAsync.mockResolvedValue([]);
});

describe('LeadsService.changeStatus: lead.status_changed', () => {
  it('is published once, with the status the compare-and-set replaced, after the write', async () => {
    repository.findVisible.mockResolvedValue(lead(LeadStatus.NEW));
    repository.transitionStatus.mockResolvedValue(lead(LeadStatus.CONTACTED));
    await service.changeStatus(actor, 'l1', { status: LeadStatus.CONTACTED });

    expect(statusEvents()).toHaveLength(1);
    expect(statusEvents()[0][1]).toMatchObject({
      organizationId: 'org',
      leadId: 'l1',
      from: LeadStatus.NEW,
      to: LeadStatus.CONTACTED,
      actorId: 'me',
    });
    expect(emitAsync.mock.invocationCallOrder[0]).toBeGreaterThan(
      repository.transitionStatus.mock.invocationCallOrder[0],
    );
  });

  it('is not published for a rejected transition', async () => {
    repository.findVisible.mockResolvedValue(lead(LeadStatus.NEW));
    await expect(
      service.changeStatus(actor, 'l1', { status: LeadStatus.QUALIFIED }),
    ).rejects.toBeInstanceOf(HttpException);
    expect(statusEvents()).toHaveLength(0);
  });

  it('is not published for the same status', async () => {
    repository.findVisible.mockResolvedValue(lead(LeadStatus.NEW));
    await expect(
      service.changeStatus(actor, 'l1', { status: LeadStatus.NEW }),
    ).rejects.toBeInstanceOf(HttpException);
    expect(statusEvents()).toHaveLength(0);
  });

  it('is not published when the lead is not visible', async () => {
    repository.findVisible.mockResolvedValue(null);
    await expect(
      service.changeStatus(actor, 'l1', { status: LeadStatus.CONTACTED }),
    ).rejects.toBeInstanceOf(HttpException);
    expect(statusEvents()).toHaveLength(0);
  });

  it('is not published when the compare-and-set loses a race', async () => {
    repository.findVisible
      .mockResolvedValueOnce(lead(LeadStatus.NEW))
      .mockResolvedValueOnce(lead(LeadStatus.UNQUALIFIED));
    repository.transitionStatus.mockResolvedValue(null);
    await expect(
      service.changeStatus(actor, 'l1', { status: LeadStatus.CONTACTED }),
    ).rejects.toBeInstanceOf(HttpException);
    expect(statusEvents()).toHaveLength(0);
  });

  it('a failing listener never fails the request', async () => {
    repository.findVisible.mockResolvedValue(lead(LeadStatus.NEW));
    repository.transitionStatus.mockResolvedValue(lead(LeadStatus.CONTACTED));
    emitAsync.mockRejectedValue(new Error('listener exploded'));
    await expect(
      service.changeStatus(actor, 'l1', { status: LeadStatus.CONTACTED }),
    ).resolves.toMatchObject({ status: LeadStatus.CONTACTED });
  });
});
