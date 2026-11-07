import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { VisibilityScope } from '../../common/visibility/visibility.types';
import { DealStatus, LeadSource, LeadStatus, Prisma } from '../../generated/prisma/client';
import { REPORT_TTL_SECONDS } from './reports.constants';
import { ReportsService } from './reports.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const ADMIN_SCOPE: VisibilityScope = { kind: 'all' };
const TEAM_SCOPE: VisibilityScope = { kind: 'owners', ownerIds: ['m1', 'r1'] };
const dec = (value: string) => new Prisma.Decimal(value);
const actor = (role: string): AuthenticatedUser => ({
  userId: 'm1',
  organizationId: ORG,
  role,
  permissions: ['reports:read'],
  mustChangePassword: false,
});

function setup(scope: VisibilityScope = ADMIN_SCOPE) {
  const repository = {
    dealsByStage: vi.fn().mockResolvedValue([]),
    closedDealsByStatus: vi.fn().mockResolvedValue([]),
    wonRevenue: vi.fn().mockResolvedValue([]),
    wonRevenueByOwner: vi.fn().mockResolvedValue([]),
    leadsBySourceAndStatus: vi.fn().mockResolvedValue([]),
    overdueTasks: vi.fn().mockResolvedValue([]),
    findUserNames: vi.fn().mockResolvedValue(new Map()),
  };
  const ownership = { resolve: vi.fn().mockResolvedValue(scope) };
  // A real cache-aside in memory, so a hit skips the computation exactly like Redis would.
  const store = new Map<string, unknown>();
  const cache = {
    remember: vi.fn(async (key: string, _ttl: number, compute: () => Promise<unknown>) => {
      if (!store.has(key)) store.set(key, await compute());
      return store.get(key);
    }),
  };
  const pipelines = {
    defaultPipelineId: vi.fn().mockResolvedValue('p-default'),
    get: vi.fn().mockResolvedValue({
      id: 'p-default',
      name: 'Sales',
      stages: [
        { id: 's1', name: 'New', position: 1, probability: 10, isWon: false, isLost: false },
        { id: 's2', name: 'Won', position: 2, probability: 100, isWon: true, isLost: false },
      ],
    }),
  };
  const service = new ReportsService(
    repository as never,
    ownership as never,
    cache as never,
    pipelines as never,
  );
  return { service, repository, ownership, cache, pipelines, store };
}

describe('ReportsService', () => {
  describe('visibility', () => {
    it.each([
      [
        'pipelineSummary',
        'dealsByStage',
        (s: ReportsService, a: AuthenticatedUser) => s.pipelineSummary(a, {}),
      ],
      [
        'winRate',
        'closedDealsByStatus',
        (s: ReportsService, a: AuthenticatedUser) => s.winRate(a, {}),
      ],
      [
        'revenueByPeriod',
        'wonRevenue',
        (s: ReportsService, a: AuthenticatedUser) => s.revenueByPeriod(a, {}),
      ],
      [
        'revenueByOwner',
        'wonRevenueByOwner',
        (s: ReportsService, a: AuthenticatedUser) => s.revenueByOwner(a, {}),
      ],
      [
        'leadConversion',
        'leadsBySourceAndStatus',
        (s: ReportsService, a: AuthenticatedUser) => s.leadConversion(a, {}),
      ],
      [
        'leadsBySource',
        'leadsBySourceAndStatus',
        (s: ReportsService, a: AuthenticatedUser) => s.leadsBySource(a, {}),
      ],
      [
        'overdueTasks',
        'overdueTasks',
        (s: ReportsService, a: AuthenticatedUser) => s.overdueTasks(a),
      ],
    ] as const)(
      '%s hands the resolved scope to the repository query',
      async (_name, query, call) => {
        const { service, repository, ownership } = setup(TEAM_SCOPE);
        const caller = actor('SALES_MANAGER');
        await call(service, caller);
        expect(ownership.resolve).toHaveBeenCalledWith(caller);
        expect(repository[query]).toHaveBeenCalled();
        // The same object, applied before aggregation: the service never filters afterwards.
        for (const [scope] of repository[query].mock.calls) expect(scope).toBe(TEAM_SCOPE);
      },
    );
  });

  describe('caching', () => {
    it('keys by organization and scope: a manager and an admin never share an entry', async () => {
      const admin = setup(ADMIN_SCOPE);
      const manager = setup(TEAM_SCOPE);
      await admin.service.winRate(actor('ADMIN'), { from: '2026-01-01', to: '2026-02-01' });
      await manager.service.winRate(actor('SALES_MANAGER'), {
        from: '2026-01-01',
        to: '2026-02-01',
      });
      const [adminKey] = admin.cache.remember.mock.calls[0];
      const [managerKey] = manager.cache.remember.mock.calls[0];
      expect(adminKey).toContain(`reports:v1:${ORG}:win-rate:all:`);
      expect(managerKey).toContain(`reports:v1:${ORG}:win-rate:owners-`);
      expect(adminKey).not.toBe(managerKey);
    });

    it('uses the standard TTL, and 60 seconds for overdue tasks', async () => {
      const { service, cache } = setup();
      await service.winRate(actor('ADMIN'), {});
      await service.overdueTasks(actor('ADMIN'));
      expect(cache.remember.mock.calls[0][1]).toBe(REPORT_TTL_SECONDS.standard);
      expect(cache.remember.mock.calls[1][1]).toBe(REPORT_TTL_SECONDS.overdueTasks);
    });

    it('a hit does not touch the repository and keeps the original generatedAt', async () => {
      vi.useFakeTimers();
      try {
        const { service, repository } = setup();
        vi.setSystemTime(new Date('2026-03-10T10:00:00Z'));
        const first = await service.winRate(actor('ADMIN'), {
          from: '2026-03-01',
          to: '2026-03-10',
        });
        vi.setSystemTime(new Date('2026-03-10T10:03:00Z'));
        const second = await service.winRate(actor('ADMIN'), {
          from: '2026-03-01',
          to: '2026-03-10',
        });
        expect(repository.closedDealsByStatus).toHaveBeenCalledTimes(1);
        expect(second.generatedAt).toBe('2026-03-10T10:00:00.000Z');
        expect(second).toEqual(first);
      } finally {
        vi.useRealTimers();
      }
    });

    it('every result-affecting parameter makes a different entry', async () => {
      const { service, cache } = setup();
      await service.revenueByPeriod(actor('ADMIN'), { from: '2026-03-01', to: '2026-03-10' });
      await service.revenueByPeriod(actor('ADMIN'), {
        from: '2026-03-01',
        to: '2026-03-10',
        interval: 'week',
      });
      await service.revenueByPeriod(actor('ADMIN'), { from: '2026-03-02', to: '2026-03-10' });
      await service.revenueByPeriod(actor('ADMIN'), { from: '2026-03-01', to: '2026-03-11' });
      const keys = cache.remember.mock.calls.map(([key]) => key);
      expect(new Set(keys).size).toBe(4);
    });

    it('rejects a bad window before any scope lookup, cache read or query', async () => {
      const { service, ownership, cache, repository } = setup();
      await expect(
        service.revenueByPeriod(actor('ADMIN'), { from: '2026-01-01', to: '2026-04-01' }),
      ).rejects.toMatchObject({ response: { code: 'INVALID_REPORT_RANGE' } });
      await expect(
        service.winRate(actor('ADMIN'), { from: '2026-02-01', to: '2026-01-01' }),
      ).rejects.toMatchObject({
        response: { code: 'INVALID_REPORT_RANGE' },
      });
      expect(ownership.resolve).not.toHaveBeenCalled();
      expect(cache.remember).not.toHaveBeenCalled();
      expect(repository.wonRevenue).not.toHaveBeenCalled();
    });

    it('names the real default pipeline in the key', async () => {
      const { service, cache, pipelines } = setup();
      await service.pipelineSummary(actor('ADMIN'), {});
      expect(pipelines.defaultPipelineId).toHaveBeenCalled();
      pipelines.defaultPipelineId.mockResolvedValue('p-other');
      await service.pipelineSummary(actor('ADMIN'), {});
      expect(cache.remember.mock.calls[0][0]).not.toBe(cache.remember.mock.calls[1][0]);
    });
  });

  describe('pipelineSummary', () => {
    it('lists every stage in board order, empty ones too, with currencies apart', async () => {
      const { service, repository } = setup();
      repository.dealsByStage.mockResolvedValue([
        { stageId: 's1', currency: 'USD', dealCount: 2, amount: dec('100') },
        { stageId: 's1', currency: 'EUR', dealCount: 1, amount: dec('50.5') },
      ]);
      const report = await service.pipelineSummary(actor('ADMIN'), { pipelineId: 'p-default' });
      expect(report.dealCount).toBe(3);
      expect(report.stages.map((s) => s.name)).toEqual(['New', 'Won']);
      expect(report.stages[0]).toMatchObject({
        dealCount: 3,
        totals: [
          { currency: 'EUR', amount: '50.50', dealCount: 1 },
          { currency: 'USD', amount: '100.00', dealCount: 2 },
        ],
      });
      expect(report.stages[1]).toMatchObject({ dealCount: 0, totals: [] });
    });
  });

  describe('winRate', () => {
    it('is null, not 0, when nothing was closed', async () => {
      const { service } = setup();
      const report = await service.winRate(actor('ADMIN'), {});
      expect(report).toMatchObject({
        wonCount: 0,
        lostCount: 0,
        closedCount: 0,
        winRate: null,
        won: [],
        lost: [],
      });
    });

    it('counts won / (won + lost) across currencies and keeps the money per currency', async () => {
      const { service, repository } = setup();
      repository.closedDealsByStatus.mockResolvedValue([
        { status: DealStatus.WON, currency: 'USD', dealCount: 1, amount: dec('0') },
        { status: DealStatus.WON, currency: 'EUR', dealCount: 1, amount: dec('10') },
        { status: DealStatus.LOST, currency: 'USD', dealCount: 1, amount: dec('5') },
      ]);
      const report = await service.winRate(actor('ADMIN'), {
        from: '2026-01-01',
        to: '2026-02-01',
      });
      expect(report).toMatchObject({
        from: '2026-01-01',
        to: '2026-02-01',
        wonCount: 2,
        lostCount: 1,
        winRate: 0.6667,
      });
      expect(report.won).toEqual([
        { currency: 'EUR', amount: '10.00', dealCount: 1 },
        { currency: 'USD', amount: '0.00', dealCount: 1 },
      ]);
    });
  });

  describe('revenueByPeriod', () => {
    it('queries one bucket at a time and fills every bucket with every currency seen', async () => {
      const { service, repository } = setup();
      repository.wonRevenue
        .mockResolvedValueOnce([{ currency: 'USD', dealCount: 2, amount: dec('300') }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ currency: 'EUR', dealCount: 1, amount: dec('0') }]);
      const report = await service.revenueByPeriod(actor('ADMIN'), {
        from: '2026-03-01',
        to: '2026-03-04',
        interval: 'day',
      });
      expect(repository.wonRevenue).toHaveBeenCalledTimes(3);
      expect(repository.wonRevenue.mock.calls[1][1]).toEqual({
        from: new Date('2026-03-02T00:00:00.000Z'),
        to: new Date('2026-03-03T00:00:00.000Z'),
      });
      expect(report.currencies).toEqual(['EUR', 'USD']);
      expect(report.dealCount).toBe(3);
      expect(report.buckets.map((b) => [b.start, b.dealCount])).toEqual([
        ['2026-03-01', 2],
        ['2026-03-02', 0],
        ['2026-03-03', 1],
      ]);
      expect(report.buckets[1].totals).toEqual([
        { currency: 'EUR', amount: '0.00', dealCount: 0 },
        { currency: 'USD', amount: '0.00', dealCount: 0 },
      ]);
      expect(report.buckets[0].totals[1]).toEqual({
        currency: 'USD',
        amount: '300.00',
        dealCount: 2,
      });
    });

    it('an empty window still lists its buckets, with no currencies to invent', async () => {
      const { service } = setup();
      const report = await service.revenueByPeriod(actor('ADMIN'), {
        from: '2026-03-01',
        to: '2026-03-03',
      });
      expect(report.currencies).toEqual([]);
      expect(report.buckets).toHaveLength(2);
      expect(report.buckets[0]).toMatchObject({ dealCount: 0, totals: [] });
    });
  });

  describe('revenueByOwner', () => {
    it('groups per owner with names, sorted by name, one total per currency', async () => {
      const { service, repository } = setup();
      repository.wonRevenueByOwner.mockResolvedValue([
        { ownerId: 'u2', currency: 'USD', dealCount: 1, amount: dec('10') },
        { ownerId: 'u1', currency: 'USD', dealCount: 1, amount: dec('20') },
        { ownerId: 'u1', currency: 'EUR', dealCount: 1, amount: dec('5') },
      ]);
      repository.findUserNames.mockResolvedValue(
        new Map([
          ['u1', 'Zed Zane'],
          ['u2', 'Amal Adel'],
        ]),
      );
      const report = await service.revenueByOwner(actor('ADMIN'), {});
      expect(report.owners.map((o) => o.ownerName)).toEqual(['Amal Adel', 'Zed Zane']);
      expect(report.owners[1].totals).toEqual([
        { currency: 'EUR', amount: '5.00', dealCount: 1 },
        { currency: 'USD', amount: '20.00', dealCount: 1 },
      ]);
      expect(report.dealCount).toBe(3);
    });
  });

  describe('lead reports', () => {
    const rows = [
      { source: LeadSource.WEBSITE, status: LeadStatus.CONVERTED, leadCount: 1 },
      { source: LeadSource.WEBSITE, status: LeadStatus.NEW, leadCount: 2 },
      { source: LeadSource.REFERRAL, status: LeadStatus.UNQUALIFIED, leadCount: 1 },
    ];

    it('conversion rate is null for an empty cohort, never a division by zero', async () => {
      const { service } = setup();
      expect(await service.leadConversion(actor('ADMIN'), {})).toMatchObject({
        totalLeads: 0,
        convertedLeads: 0,
        conversionRate: null,
      });
    });

    it('conversion rate is converted / created', async () => {
      const { service, repository } = setup();
      repository.leadsBySourceAndStatus.mockResolvedValue(rows);
      expect(await service.leadConversion(actor('ADMIN'), {})).toMatchObject({
        totalLeads: 4,
        convertedLeads: 1,
        conversionRate: 0.25,
      });
    });

    it('leads by source lists every source (zeros included), most leads first', async () => {
      const { service, repository } = setup();
      repository.leadsBySourceAndStatus.mockResolvedValue(rows);
      const report = await service.leadsBySource(actor('ADMIN'), {});
      expect(report.sources).toHaveLength(Object.values(LeadSource).length);
      expect(report.sources[0]).toEqual({
        source: LeadSource.WEBSITE,
        leadCount: 3,
        convertedCount: 1,
      });
      expect(report.sources[1]).toEqual({
        source: LeadSource.REFERRAL,
        leadCount: 1,
        convertedCount: 0,
      });
      expect(report.sources.at(-1)).toMatchObject({ leadCount: 0, convertedCount: 0 });
      expect(report.totalLeads).toBe(4);
    });
  });

  describe('overdueTasks', () => {
    it('judges overdue against the instant it reports as generatedAt', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-03-10T10:00:00Z'));
        const { service, repository } = setup();
        const report = await service.overdueTasks(actor('ADMIN'));
        expect(repository.overdueTasks.mock.calls[0][1]).toEqual(new Date('2026-03-10T10:00:00Z'));
        expect(report.generatedAt).toBe('2026-03-10T10:00:00.000Z');
      } finally {
        vi.useRealTimers();
      }
    });

    it('totals, per assignee (most first) and every priority including zeros', async () => {
      const { service, repository } = setup();
      repository.overdueTasks.mockResolvedValue([
        { assigneeId: 'u1', priority: 'HIGH', taskCount: 1 },
        { assigneeId: 'u1', priority: 'LOW', taskCount: 1 },
        { assigneeId: 'u2', priority: 'HIGH', taskCount: 3 },
      ]);
      repository.findUserNames.mockResolvedValue(
        new Map([
          ['u1', 'Ann'],
          ['u2', 'Bob'],
        ]),
      );
      const report = await service.overdueTasks(actor('ADMIN'));
      expect(report.totalOverdue).toBe(5);
      expect(report.byAssignee).toEqual([
        { assigneeId: 'u2', assigneeName: 'Bob', overdueCount: 3 },
        { assigneeId: 'u1', assigneeName: 'Ann', overdueCount: 2 },
      ]);
      expect(report.byPriority.find((p) => p.priority === 'HIGH')?.overdueCount).toBe(4);
      expect(report.byPriority.find((p) => p.priority === 'URGENT')?.overdueCount).toBe(0);
    });
  });
});
