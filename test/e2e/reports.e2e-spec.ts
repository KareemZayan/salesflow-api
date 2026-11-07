import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import request from 'supertest';
import type { PrismaClient } from '../../prisma/seed/prisma-client';
import { ROLE_NAMES } from '../../prisma/seed/permissions';
import { APP_CONFIG_KEY, AppConfig } from '../../src/config/app.config';
import {
  createDeal,
  createLead,
  createPipeline,
  createTask,
  findDefaultPipeline,
} from '../factories/crm.factory';
import { createTestPrisma, resetDatabase } from '../factories/database';
import {
  createOrganization,
  createUser,
  type TestOrganization,
  type TestUser,
} from '../factories/organization.factory';
import { createTestApp, purgeTestQueues } from '../setup/create-test-app';

const API = '/api/v1/reports';
const MISSING_ID = '11111111-1111-4111-8111-111111111111';
const JAN = '?from=2026-01-01&to=2026-02-01';
const at = (iso: string) => new Date(iso);

interface Tokens {
  accessToken: string;
}

// The fixture below is arranged so every expected number can be checked by hand:
//
//   deals (window = January 2026, `to` exclusive)        owner    status  money      closedAt
//   d1                                                   manager  WON     USD 1000   Jan 5
//   d2                                                   report   WON     USD 500.50 Jan 5 23:59:59.999
//   d3                                                   report   WON     EUR 200    Jan 20
//   d4                                                   repX     WON     USD 300    Jan 10
//   d7 (zero amount, exactly `from`)                     manager  WON     USD 0      Jan 1 00:00:00.000
//   d14 (last instant before `to`)                       manager  WON     USD 25     Jan 31 23:59:59.999
//   d5                                                   manager  LOST    USD 100    Jan 12
//   d6                                                   repX     LOST    USD 50     Jan 13
//   d8 (exactly `to`: out)                               manager  WON     USD 999    Feb 1 00:00:00.000
//   d9 (1 ms before `from`: out)                         report   WON     USD 111    Dec 31 23:59:59.999
//   d10 (soft deleted: out)                              manager  WON     USD 777    Jan 2
//   d11 (open)                                           manager  OPEN    USD 400    -
//
// manager's team = manager + report. repX is outside it. Organization B owns a WON USD 5000 deal.
describe('Reports (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let redis: Redis;
  let cachePrefix: string;
  let orgA: TestOrganization;
  let orgB: TestOrganization;
  let manager: TestUser;
  let report: TestUser;
  let repX: TestUser;
  let adminT: Tokens;
  let managerT: Tokens;
  let repXT: Tokens;
  let adminBT: Tokens;
  let pipelineA: Awaited<ReturnType<typeof findDefaultPipeline>>;

  const http = () => request(app.getHttpServer());
  const signIn = async ({ email, password }: Pick<TestUser, 'email' | 'password'>) =>
    (await http().post('/api/v1/auth/login').send({ email, password }).expect(200)).body as Tokens;
  const as = (tokens: Tokens) => ({ Authorization: `Bearer ${tokens.accessToken}` });
  const get = (tokens: Tokens, path: string) => http().get(`${API}/${path}`).set(as(tokens));
  const body = async (tokens: Tokens, path: string) =>
    (await get(tokens, path).expect(200)).body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const owned = (org: TestOrganization, user: Pick<TestUser, 'id'>) => ({
    organizationId: org.id,
    ownerId: user.id,
  });

  async function arrangeDeals(
    org: TestOrganization,
    pipeline: typeof pipelineA,
    users: { manager: TestUser; report: TestUser; repX: TestUser },
  ) {
    const open = pipeline.stages.find((s) => !s.isWon && !s.isLost)!;
    const won = pipeline.stages.find((s) => s.isWon)!;
    const lost = pipeline.stages.find((s) => s.isLost)!;
    const place = (stage: { id: string }) => ({ pipelineId: pipeline.id, stageId: stage.id });
    const deal = (
      owner: TestUser,
      stage: { id: string },
      amount: string,
      currency: string,
      status: 'WON' | 'LOST' | 'OPEN',
      closedAt?: string,
      deletedAt?: Date,
    ) =>
      createDeal(prisma, owned(org, owner), place(stage), {
        amount,
        currency,
        status,
        closedAt: closedAt ? at(closedAt) : undefined,
        deletedAt,
      });
    await deal(users.manager, won, '1000.00', 'USD', 'WON', '2026-01-05T10:00:00.000Z');
    await deal(users.report, won, '500.50', 'USD', 'WON', '2026-01-05T23:59:59.999Z');
    await deal(users.report, won, '200.00', 'EUR', 'WON', '2026-01-20T00:00:00.000Z');
    await deal(users.repX, won, '300.00', 'USD', 'WON', '2026-01-10T12:00:00.000Z');
    await deal(users.manager, won, '0.00', 'USD', 'WON', '2026-01-01T00:00:00.000Z');
    await deal(users.manager, won, '25.00', 'USD', 'WON', '2026-01-31T23:59:59.999Z');
    await deal(users.manager, lost, '100.00', 'USD', 'LOST', '2026-01-12T12:00:00.000Z');
    await deal(users.repX, lost, '50.00', 'USD', 'LOST', '2026-01-13T12:00:00.000Z');
    await deal(users.manager, won, '999.00', 'USD', 'WON', '2026-02-01T00:00:00.000Z');
    await deal(users.report, won, '111.00', 'USD', 'WON', '2025-12-31T23:59:59.999Z');
    await deal(users.manager, won, '777.00', 'USD', 'WON', '2026-01-02T12:00:00.000Z', new Date());
    await deal(users.manager, open, '400.00', 'USD', 'OPEN');
  }

  beforeAll(async () => {
    // Real compose Redis (cache on), no workers: reports use no queue.
    app = await createTestApp({ queue: { workers: false } });
    prisma = createTestPrisma();
    const config = app.get(ConfigService).getOrThrow<AppConfig>(APP_CONFIG_KEY);
    cachePrefix = `${config.queue.prefix}:cache:`;
    redis = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
    });
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    orgA = await createOrganization(prisma, 'orga');
    orgB = await createOrganization(prisma, 'orgb');
    manager = await createUser(prisma, orgA, { role: ROLE_NAMES.SALES_MANAGER });
    report = await createUser(prisma, orgA, { managerId: manager.id });
    repX = await createUser(prisma, orgA);
    // Distinct names, so "sorted by owner name" is a real assertion.
    await prisma.user.update({ where: { id: manager.id }, data: { firstName: 'Manny' } });
    await prisma.user.update({ where: { id: report.id }, data: { firstName: 'Rita' } });
    await prisma.user.update({ where: { id: repX.id }, data: { firstName: 'Xavi' } });
    [adminT, managerT, repXT, adminBT] = await Promise.all(
      [orgA.admin, manager, repX, orgB.admin].map(signIn),
    );
    pipelineA = await findDefaultPipeline(prisma, orgA.id);
    await arrangeDeals(orgA, pipelineA, { manager, report, repX });
  });

  afterAll(async () => {
    // Only this app's own cache keys (its private prefix), never the rest of Redis.
    const keys = await redis.keys(`${cachePrefix}*`);
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
    await purgeTestQueues(app);
    await app.close();
    await prisma.$disconnect();
  });

  describe('authentication and permissions', () => {
    const endpoints = [
      'pipeline-summary',
      `win-rate${JAN}`,
      `revenue/by-period${JAN}`,
      `revenue/by-owner${JAN}`,
      `lead-conversion${JAN}`,
      `leads-by-source${JAN}`,
      'overdue-tasks',
    ];

    it.each(endpoints)('%s: 401 without a token', async (path) => {
      await http().get(`${API}/${path}`).expect(401);
    });

    it.each(endpoints)('%s: 403 for a sales rep (no reports:read)', async (path) => {
      const res = await get(repXT, path).expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it.each(endpoints)('%s: 200 for a sales manager and an admin', async (path) => {
      await get(managerT, path).expect(200);
      await get(adminT, path).expect(200);
    });
  });

  describe('validation', () => {
    it.each([
      ['from after to', 'win-rate?from=2026-02-01&to=2026-01-01', 'INVALID_REPORT_RANGE'],
      ['empty window', 'win-rate?from=2026-01-01&to=2026-01-01', 'INVALID_REPORT_RANGE'],
      ['over 366 days', 'lead-conversion?from=2025-01-01&to=2026-02-01', 'INVALID_REPORT_RANGE'],
      [
        'too many days',
        'revenue/by-period?from=2026-01-01&to=2026-02-02&interval=day',
        'INVALID_REPORT_RANGE',
      ],
      [
        'too many months',
        'revenue/by-period?from=2026-01-15&to=2027-01-15&interval=month',
        'INVALID_REPORT_RANGE',
      ],
      [
        'too many weeks',
        'revenue/by-period?from=2026-01-04&to=2027-01-05&interval=week',
        'INVALID_REPORT_RANGE',
      ],
      ['invalid interval', 'revenue/by-period?interval=year', 'VALIDATION_FAILED'],
      ['impossible date', 'win-rate?from=2026-02-31', 'VALIDATION_FAILED'],
      ['not a date', 'win-rate?to=tomorrow', 'VALIDATION_FAILED'],
      ['timestamp instead of a day', 'win-rate?from=2026-01-01T00:00:00Z', 'VALIDATION_FAILED'],
      ['unknown parameter', 'leads-by-source?foo=1', 'VALIDATION_FAILED'],
      [
        'organizationId is never accepted',
        `pipeline-summary?organizationId=${MISSING_ID}`,
        'VALIDATION_FAILED',
      ],
      ['bad pipeline id', 'pipeline-summary?pipelineId=nope', 'VALIDATION_FAILED'],
    ])('400 for %s', async (_name, path, code) => {
      const res = await get(adminT, path).expect(400);
      expect(res.body.code).toBe(code);
    });

    it('accepts exactly the caps: 31 days, 12 months, 53 weeks', async () => {
      await get(adminT, 'revenue/by-period?from=2026-01-01&to=2026-02-01&interval=day').expect(200);
      await get(adminT, 'revenue/by-period?from=2026-01-01&to=2027-01-01&interval=month').expect(
        200,
      );
      const weeks = await body(
        adminT,
        'revenue/by-period?from=2026-01-01&to=2027-01-02&interval=week',
      );
      expect(weeks.buckets).toHaveLength(53);
    });
  });

  describe('pipeline summary', () => {
    it('admin: every stage of the default pipeline, money per currency, soft-deleted excluded', async () => {
      const res = await body(adminT, 'pipeline-summary');
      expect(res.pipeline).toEqual({ id: pipelineA.id, name: pipelineA.name });
      expect(res.stages.map((s: { position: number }) => s.position)).toEqual(
        pipelineA.stages.map((s) => s.position),
      );
      expect(res.dealCount).toBe(11);
      const won = res.stages.find((s: { isWon: boolean }) => s.isWon);
      const lost = res.stages.find((s: { isLost: boolean }) => s.isLost);
      const open = res.stages[0];
      expect(won).toMatchObject({ dealCount: 8 });
      expect(won.totals).toEqual([
        { currency: 'EUR', amount: '200.00', dealCount: 1 },
        { currency: 'USD', amount: '2935.50', dealCount: 7 },
      ]);
      expect(lost).toMatchObject({
        dealCount: 2,
        totals: [{ currency: 'USD', amount: '150.00', dealCount: 2 }],
      });
      expect(open).toMatchObject({
        dealCount: 1,
        totals: [{ currency: 'USD', amount: '400.00', dealCount: 1 }],
      });
    });

    it('manager: only own + team deals', async () => {
      const res = await body(managerT, 'pipeline-summary');
      expect(res.dealCount).toBe(9);
      const won = res.stages.find((s: { isWon: boolean }) => s.isWon);
      expect(won.totals).toEqual([
        { currency: 'EUR', amount: '200.00', dealCount: 1 },
        { currency: 'USD', amount: '2635.50', dealCount: 6 },
      ]);
    });

    it('an explicit empty pipeline answers every stage with zeros', async () => {
      const empty = await createPipeline(prisma, { organizationId: orgA.id });
      const res = await body(adminT, `pipeline-summary?pipelineId=${empty.id}`);
      expect(res.dealCount).toBe(0);
      expect(res.stages.length).toBe(empty.stages.length);
      expect(
        res.stages.every(
          (s: { dealCount: number; totals: unknown[] }) =>
            s.dealCount === 0 && s.totals.length === 0,
        ),
      ).toBe(true);
    });

    it('404 for a pipeline that does not exist or belongs to another organization', async () => {
      const foreign = await findDefaultPipeline(prisma, orgB.id);
      await get(adminT, `pipeline-summary?pipelineId=${MISSING_ID}`).expect(404);
      await get(adminT, `pipeline-summary?pipelineId=${foreign.id}`).expect(404);
    });
  });

  describe('win rate', () => {
    it('admin: counts by closedAt in [from, to), money per currency', async () => {
      const res = await body(adminT, `win-rate${JAN}`);
      expect(res).toMatchObject({
        from: '2026-01-01',
        to: '2026-02-01',
        wonCount: 6,
        lostCount: 2,
        closedCount: 8,
        winRate: 0.75,
      });
      expect(res.won).toEqual([
        { currency: 'EUR', amount: '200.00', dealCount: 1 },
        { currency: 'USD', amount: '1825.50', dealCount: 5 },
      ]);
      expect(res.lost).toEqual([{ currency: 'USD', amount: '150.00', dealCount: 2 }]);
    });

    it('manager: only own + team (repX deals are invisible)', async () => {
      const res = await body(managerT, `win-rate${JAN}`);
      expect(res).toMatchObject({ wonCount: 5, lostCount: 1, winRate: 0.8333 });
      expect(res.won).toEqual([
        { currency: 'EUR', amount: '200.00', dealCount: 1 },
        { currency: 'USD', amount: '1525.50', dealCount: 4 },
      ]);
    });

    it('a window with no closed deals has a null rate, not zero', async () => {
      const res = await body(adminT, 'win-rate?from=2020-01-01&to=2020-02-01');
      expect(res).toMatchObject({
        wonCount: 0,
        lostCount: 0,
        closedCount: 0,
        winRate: null,
        won: [],
        lost: [],
      });
    });

    it('`from` is inclusive, `to` exclusive, in UTC', async () => {
      // d7 closes exactly at from; d8 exactly at to.
      expect((await body(adminT, 'win-rate?from=2026-01-01&to=2026-01-02')).wonCount).toBe(1);
      expect((await body(adminT, 'win-rate?from=2026-01-31&to=2026-02-01')).wonCount).toBe(1);
      expect((await body(adminT, 'win-rate?from=2026-02-01&to=2026-02-02')).wonCount).toBe(1);
      expect((await body(adminT, 'win-rate?from=2025-12-31&to=2026-01-01')).wonCount).toBe(1);
    });

    it('defaults to the last 30 days (today included) without parameters', async () => {
      const res = await body(adminT, 'win-rate');
      const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
      expect(res.to).toBe(tomorrow);
    });
  });

  describe('revenue by period', () => {
    it('daily: every day present, currencies filled with 0.00, zero amounts kept', async () => {
      const res = await body(adminT, `revenue/by-period${JAN}&interval=day`);
      expect(res.interval).toBe('day');
      expect(res.currencies).toEqual(['EUR', 'USD']);
      expect(res.buckets).toHaveLength(31);
      expect(res.dealCount).toBe(6);
      const day = (start: string) => res.buckets.find((b: { start: string }) => b.start === start);
      expect(day('2026-01-01')).toMatchObject({ end: '2026-01-02', dealCount: 1 });
      expect(day('2026-01-01').totals).toEqual([
        { currency: 'EUR', amount: '0.00', dealCount: 0 },
        { currency: 'USD', amount: '0.00', dealCount: 1 },
      ]);
      expect(day('2026-01-05').totals).toEqual([
        { currency: 'EUR', amount: '0.00', dealCount: 0 },
        { currency: 'USD', amount: '1500.50', dealCount: 2 },
      ]);
      expect(day('2026-01-20').totals[0]).toEqual({
        currency: 'EUR',
        amount: '200.00',
        dealCount: 1,
      });
      expect(day('2026-01-31').totals[1]).toEqual({
        currency: 'USD',
        amount: '25.00',
        dealCount: 1,
      });
      expect(day('2026-01-06')).toMatchObject({ dealCount: 0 });
    });

    it('weekly: weeks start on Monday and the edges are clamped to the window', async () => {
      const res = await body(adminT, `revenue/by-period${JAN}&interval=week`);
      expect(res.buckets.map((b: { start: string; end: string }) => [b.start, b.end])).toEqual([
        ['2026-01-01', '2026-01-05'],
        ['2026-01-05', '2026-01-12'],
        ['2026-01-12', '2026-01-19'],
        ['2026-01-19', '2026-01-26'],
        ['2026-01-26', '2026-02-01'],
      ]);
      expect(res.buckets.map((b: { dealCount: number }) => b.dealCount)).toEqual([1, 3, 0, 1, 1]);
      expect(res.buckets[1].totals[1]).toEqual({
        currency: 'USD',
        amount: '1800.50',
        dealCount: 3,
      });
    });

    it('monthly: a deal 1 ms before/at a month boundary lands in the right month (UTC)', async () => {
      const res = await body(
        adminT,
        'revenue/by-period?from=2025-12-01&to=2026-03-01&interval=month',
      );
      expect(
        res.buckets.map((b: { start: string; dealCount: number }) => [b.start, b.dealCount]),
      ).toEqual([
        ['2025-12-01', 1],
        ['2026-01-01', 6],
        ['2026-02-01', 1],
      ]);
      expect(res.buckets[0].totals).toEqual([
        { currency: 'EUR', amount: '0.00', dealCount: 0 },
        { currency: 'USD', amount: '111.00', dealCount: 1 },
      ]);
      expect(res.buckets[2].totals[1]).toEqual({ currency: 'USD', amount: '999.00', dealCount: 1 });
    });

    it('manager: team only; a window without revenue lists buckets and no currencies', async () => {
      const team = await body(managerT, `revenue/by-period${JAN}&interval=month`);
      expect(team.buckets[0].totals).toEqual([
        { currency: 'EUR', amount: '200.00', dealCount: 1 },
        { currency: 'USD', amount: '1525.50', dealCount: 4 },
      ]);
      const none = await body(adminT, 'revenue/by-period?from=2020-01-01&to=2020-01-04');
      expect(none.currencies).toEqual([]);
      expect(none.buckets).toHaveLength(3);
      expect(none.buckets[0]).toMatchObject({ dealCount: 0, totals: [] });
    });
  });

  describe('revenue by owner', () => {
    it('admin: every owner with revenue, sorted by name, currencies apart', async () => {
      const res = await body(adminT, `revenue/by-owner${JAN}`);
      expect(res.dealCount).toBe(6);
      expect(res.owners).toEqual([
        {
          ownerId: manager.id,
          ownerName: 'Manny User',
          dealCount: 3,
          totals: [{ currency: 'USD', amount: '1025.00', dealCount: 3 }],
        },
        {
          ownerId: report.id,
          ownerName: 'Rita User',
          dealCount: 2,
          totals: [
            { currency: 'EUR', amount: '200.00', dealCount: 1 },
            { currency: 'USD', amount: '500.50', dealCount: 1 },
          ],
        },
        {
          ownerId: repX.id,
          ownerName: 'Xavi User',
          dealCount: 1,
          totals: [{ currency: 'USD', amount: '300.00', dealCount: 1 }],
        },
      ]);
    });

    it('manager: never lists an owner outside the team', async () => {
      const res = await body(managerT, `revenue/by-owner${JAN}`);
      expect(res.owners.map((o: { ownerId: string }) => o.ownerId)).toEqual([
        manager.id,
        report.id,
      ]);
      expect(res.dealCount).toBe(5);
    });
  });

  describe('lead reports', () => {
    beforeEach(async () => {
      const lead = (
        owner: TestUser,
        source: 'WEBSITE' | 'REFERRAL',
        status: 'NEW' | 'QUALIFIED' | 'CONVERTED',
        createdAt: string,
        deletedAt?: Date,
      ) =>
        createLead(prisma, owned(orgA, owner), {
          source,
          status,
          createdAt: at(createdAt),
          convertedAt: status === 'CONVERTED' ? at(createdAt) : undefined,
          deletedAt,
        });
      await lead(manager, 'WEBSITE', 'NEW', '2026-01-03T00:00:00Z');
      await lead(manager, 'WEBSITE', 'CONVERTED', '2026-01-04T00:00:00Z');
      await lead(report, 'REFERRAL', 'QUALIFIED', '2026-01-10T00:00:00Z');
      await lead(repX, 'REFERRAL', 'CONVERTED', '2026-01-15T00:00:00Z');
      await lead(repX, 'WEBSITE', 'NEW', '2026-01-31T23:59:59.999Z');
      await lead(repX, 'WEBSITE', 'NEW', '2026-02-01T00:00:00.000Z'); // exactly `to`: out
      await lead(manager, 'WEBSITE', 'NEW', '2026-01-05T00:00:00Z', new Date()); // soft deleted: out
    });

    it('conversion: a cohort of leads created in the window; admin sees all', async () => {
      expect(await body(adminT, `lead-conversion${JAN}`)).toMatchObject({
        totalLeads: 5,
        convertedLeads: 2,
        conversionRate: 0.4,
      });
    });

    it('conversion: manager sees own + team only', async () => {
      expect(await body(managerT, `lead-conversion${JAN}`)).toMatchObject({
        totalLeads: 3,
        convertedLeads: 1,
        conversionRate: 0.3333,
      });
    });

    it('conversion: an empty cohort has a null rate', async () => {
      expect(await body(adminT, 'lead-conversion?from=2020-01-01&to=2020-02-01')).toMatchObject({
        totalLeads: 0,
        convertedLeads: 0,
        conversionRate: null,
      });
    });

    it('leads by source: every source listed, busiest first, converted counted apart', async () => {
      const res = await body(adminT, `leads-by-source${JAN}`);
      expect(res.totalLeads).toBe(5);
      expect(res.sources[0]).toEqual({ source: 'WEBSITE', leadCount: 3, convertedCount: 1 });
      expect(res.sources[1]).toEqual({ source: 'REFERRAL', leadCount: 2, convertedCount: 1 });
      expect(res.sources.length).toBeGreaterThan(2);
      expect(res.sources.slice(2).every((s: { leadCount: number }) => s.leadCount === 0)).toBe(
        true,
      );
    });

    it('leads by source: manager scope', async () => {
      const res = await body(managerT, `leads-by-source${JAN}`);
      expect(res.sources.slice(0, 2)).toEqual([
        { source: 'WEBSITE', leadCount: 2, convertedCount: 1 },
        { source: 'REFERRAL', leadCount: 1, convertedCount: 0 },
      ]);
    });
  });

  describe('overdue tasks', () => {
    const PAST = at('2000-01-01T00:00:00Z');
    const task = (assignee: TestUser, overrides: Parameters<typeof createTask>[2]) =>
      createTask(prisma, { organizationId: orgA.id, assigneeId: assignee.id }, overrides);

    beforeEach(async () => {
      await task(manager, { status: 'OPEN', priority: 'HIGH', dueDate: PAST });
      await task(report, { status: 'IN_PROGRESS', priority: 'LOW', dueDate: PAST });
      await task(report, { status: 'OPEN', priority: 'HIGH', dueDate: PAST });
      await task(repX, { status: 'OPEN', priority: 'URGENT', dueDate: PAST });
      await task(manager, { status: 'OPEN', dueDate: at('2099-01-01T00:00:00Z') }); // not due yet
      await task(report, { status: 'COMPLETED', dueDate: PAST, completedAt: PAST }); // closed
      await task(manager, { status: 'OPEN' }); // no due date
    });

    it('admin: totals per assignee (most first) and per priority, zeros included', async () => {
      const res = await body(adminT, 'overdue-tasks');
      expect(res.totalOverdue).toBe(4);
      expect(res.byAssignee).toEqual([
        { assigneeId: report.id, assigneeName: 'Rita User', overdueCount: 2 },
        { assigneeId: manager.id, assigneeName: 'Manny User', overdueCount: 1 },
        { assigneeId: repX.id, assigneeName: 'Xavi User', overdueCount: 1 },
      ]);
      const priorities = Object.fromEntries(
        res.byPriority.map((p: { priority: string; overdueCount: number }) => [
          p.priority,
          p.overdueCount,
        ]),
      );
      expect(priorities).toEqual({ LOW: 1, MEDIUM: 0, HIGH: 2, URGENT: 1 });
    });

    it('manager: follows the assignee, team only', async () => {
      const res = await body(managerT, 'overdue-tasks');
      expect(res.totalOverdue).toBe(3);
      expect(res.byAssignee.map((a: { assigneeId: string }) => a.assigneeId)).not.toContain(
        repX.id,
      );
    });

    it('agrees with GET /tasks?overdue=true (one definition of overdue)', async () => {
      const list = await http().get('/api/v1/tasks?overdue=true').set(as(adminT)).expect(200);
      const total = (await body(adminT, 'overdue-tasks')).totalOverdue;
      expect(list.body.meta.total).toBe(total);
    });
  });

  describe('tenant isolation', () => {
    beforeEach(async () => {
      const pipelineB = await findDefaultPipeline(prisma, orgB.id);
      const won = pipelineB.stages.find((s) => s.isWon)!;
      await createDeal(
        prisma,
        owned(orgB, orgB.admin),
        { pipelineId: pipelineB.id, stageId: won.id },
        { amount: '5000.00', currency: 'USD', status: 'WON', closedAt: at('2026-01-05T10:00:00Z') },
      );
      await createLead(prisma, owned(orgB, orgB.admin), { createdAt: at('2026-01-05T10:00:00Z') });
      await createTask(
        prisma,
        { organizationId: orgB.id, assigneeId: orgB.admin.id },
        { status: 'OPEN', dueDate: at('2000-01-01T00:00:00Z') },
      );
    });

    it('organization B never sees organization A, and A never sees B (even for the same parameters)', async () => {
      // A first: its answer is cached; B asks for exactly the same parameters afterwards.
      const a = await body(adminT, `win-rate${JAN}`);
      const b = await body(adminBT, `win-rate${JAN}`);
      expect(a.wonCount).toBe(6);
      expect(b).toMatchObject({
        wonCount: 1,
        lostCount: 0,
        winRate: 1,
        won: [{ currency: 'USD', amount: '5000.00', dealCount: 1 }],
      });

      const owners = await body(adminBT, `revenue/by-owner${JAN}`);
      expect(owners.owners.map((o: { ownerId: string }) => o.ownerId)).toEqual([orgB.admin.id]);
      expect((await body(adminBT, `lead-conversion${JAN}`)).totalLeads).toBe(1);
      expect((await body(adminBT, 'overdue-tasks')).totalOverdue).toBe(1);
      expect((await body(adminBT, 'pipeline-summary')).dealCount).toBe(1);
      expect((await body(adminT, 'overdue-tasks')).totalOverdue).toBe(0);
    });

    it('cache keys are namespaced by organization', async () => {
      await body(adminT, `win-rate${JAN}`);
      await body(adminBT, `win-rate${JAN}`);
      const keys = (await redis.keys(`${cachePrefix}reports:v1:*:win-rate:*`)).map((k) =>
        k.slice(cachePrefix.length),
      );
      const forOrg = (org: TestOrganization) =>
        keys.filter((k) => k.startsWith(`reports:v1:${org.id}:`));
      expect(forOrg(orgA)).toHaveLength(1);
      expect(forOrg(orgB)).toHaveLength(1);
      expect(forOrg(orgA)[0]).not.toBe(forOrg(orgB)[0]);
    });
  });

  describe('cache', () => {
    it('a second call within the TTL is a hit: same numbers, same generatedAt', async () => {
      const first = await body(adminT, `win-rate${JAN}`);
      // The database changes; the cached answer does not (no invalidation, by design).
      const won = pipelineA.stages.find((s) => s.isWon)!;
      await createDeal(
        prisma,
        owned(orgA, manager),
        { pipelineId: pipelineA.id, stageId: won.id },
        {
          amount: '1.00',
          status: 'WON',
          closedAt: at('2026-01-06T00:00:00Z'),
        },
      );
      const second = await body(adminT, `win-rate${JAN}`);
      expect(second).toEqual(first);
      expect(second.generatedAt).toBe(first.generatedAt);
      expect(second.wonCount).toBe(6);
    });

    it('different parameters are a different entry and see the new data', async () => {
      expect((await body(adminT, `win-rate${JAN}`)).wonCount).toBe(6);
      const won = pipelineA.stages.find((s) => s.isWon)!;
      await createDeal(
        prisma,
        owned(orgA, manager),
        { pipelineId: pipelineA.id, stageId: won.id },
        {
          status: 'WON',
          closedAt: at('2026-01-06T00:00:00Z'),
        },
      );
      // Same window: cached, still 6. A different window is another key, computed now: d7 + d1 + d2 + the new deal = 4.
      expect((await body(adminT, `win-rate${JAN}`)).wonCount).toBe(6);
      expect((await body(adminT, 'win-rate?from=2026-01-01&to=2026-01-08')).wonCount).toBe(4);
    });

    it("a manager and an admin never read each other's entries", async () => {
      // Manager first: the manager-scoped answer is cached. The admin must not receive it.
      const m1 = await body(managerT, `win-rate${JAN}`);
      const a1 = await body(adminT, `win-rate${JAN}`);
      expect(m1.wonCount).toBe(5);
      expect(a1.wonCount).toBe(6);
      // And back: each one keeps getting its own cached answer.
      const m2 = await body(managerT, `win-rate${JAN}`);
      const a2 = await body(adminT, `win-rate${JAN}`);
      expect(m2).toEqual(m1);
      expect(a2).toEqual(a1);

      const keys = (await redis.keys(`${cachePrefix}reports:v1:${orgA.id}:win-rate:*`)).map((k) =>
        k.slice(cachePrefix.length),
      );
      expect(keys).toHaveLength(2);
      expect(keys.some((k) => k.includes(':all:'))).toBe(true);
      expect(keys.some((k) => k.includes(':owners-'))).toBe(true);
    });

    it('two managers with different teams do not share an entry either', async () => {
      const other = await createUser(prisma, orgA, { role: ROLE_NAMES.SALES_MANAGER });
      const otherT = await signIn(other);
      expect((await body(managerT, `win-rate${JAN}`)).wonCount).toBe(5);
      expect((await body(otherT, `win-rate${JAN}`)).wonCount).toBe(0);
    });

    it('entries expire: a TTL is always set (5 minutes, 60 seconds for overdue tasks)', async () => {
      await body(adminT, `win-rate${JAN}`);
      await body(adminT, 'overdue-tasks');
      const ttl = async (name: string) => {
        const [key] = await redis.keys(`${cachePrefix}reports:v1:${orgA.id}:${name}:*`);
        return redis.ttl(key);
      };
      expect(await ttl('win-rate')).toBeGreaterThan(0);
      expect(await ttl('win-rate')).toBeLessThanOrEqual(300);
      expect(await ttl('overdue-tasks')).toBeGreaterThan(0);
      expect(await ttl('overdue-tasks')).toBeLessThanOrEqual(60);
    });

    it('errors are not cached', async () => {
      const before = (await redis.keys(`${cachePrefix}reports:v1:${orgA.id}:*`)).length;
      await get(adminT, `pipeline-summary?pipelineId=${MISSING_ID}`).expect(404);
      expect((await redis.keys(`${cachePrefix}reports:v1:${orgA.id}:*`)).length).toBe(before);
    });
  });

  describe('Redis outage', () => {
    let degraded: INestApplication;
    let degradedAdmin: Tokens;

    beforeAll(async () => {
      // The default e2e environment points Redis at a port nothing listens on.
      degraded = await createTestApp();
    });

    afterAll(async () => {
      await degraded.close();
    });

    it('every report still answers 200 with correct numbers, computed fresh each time', async () => {
      degradedAdmin = (
        await request(degraded.getHttpServer())
          .post('/api/v1/auth/login')
          .send({ email: orgA.admin.email, password: orgA.admin.password })
          .expect(200)
      ).body as Tokens;
      const call = (path: string) =>
        request(degraded.getHttpServer()).get(`${API}/${path}`).set(as(degradedAdmin));

      const first = await call(`win-rate${JAN}`).expect(200);
      expect(first.body).toMatchObject({ wonCount: 6, lostCount: 2, winRate: 0.75 });
      for (const path of [
        'pipeline-summary',
        `revenue/by-period${JAN}`,
        `revenue/by-owner${JAN}`,
        `lead-conversion${JAN}`,
        `leads-by-source${JAN}`,
        'overdue-tasks',
      ]) {
        await call(path).expect(200);
      }
      // Nothing was remembered: a second call is a fresh computation (a new generatedAt).
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await call(`win-rate${JAN}`).expect(200);
      expect(second.body.generatedAt).not.toBe(first.body.generatedAt);
    });
  });
});
