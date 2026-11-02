import { INestApplication } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import request from 'supertest';
import type { PrismaClient } from '../../prisma/seed/prisma-client';
import { ROLE_NAMES } from '../../prisma/seed/permissions';
import {
  acquireLock,
  type LockKind,
  type LockMode,
} from '../../src/infrastructure/prisma/advisory-lock';
import {
  createContact,
  createDeal,
  createPipeline,
  findDefaultPipeline,
} from '../factories/crm.factory';
import { createTestPrisma, resetDatabase } from '../factories/database';
import {
  createCustomRole,
  createOrganization,
  createUser,
  type TestOrganization,
  type TestUser,
} from '../factories/organization.factory';
import { createTestApp } from '../setup/create-test-app';

const API = '/api/v1/deals';
const RACE_ITERATIONS = 20;
const MISSING_ID = '11111111-1111-4111-8111-111111111111';

interface Tokens {
  accessToken: string;
}

describe('Deal stage moves (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let events: EventEmitter2;
  let orgA: TestOrganization;
  let orgB: TestOrganization;
  let manager: TestUser;
  let report: TestUser;
  let repX: TestUser;
  let readOnly: TestUser; // deals:read only
  let nobody: TestUser;
  let repB: TestUser;
  let adminT: Tokens;
  let managerT: Tokens;
  let reportT: Tokens;
  let repXT: Tokens;
  let readOnlyT: Tokens;
  let nobodyT: Tokens;
  let repBT: Tokens;
  // [Prospecting, Qualified, Proposal, Negotiation, Won, Lost]
  let stages: { id: string; name: string }[];
  let pipelineA: Awaited<ReturnType<typeof findDefaultPipeline>>;

  const http = () => request(app.getHttpServer());
  const signIn = async ({ email, password }: Pick<TestUser, 'email' | 'password'>) =>
    (await http().post('/api/v1/auth/login').send({ email, password }).expect(200)).body as Tokens;
  const as = (tokens: Tokens) => ({ Authorization: `Bearer ${tokens.accessToken}` });
  const owned = (org: TestOrganization, user: Pick<TestUser, 'id'>) => ({
    organizationId: org.id,
    ownerId: user.id,
  });
  const move = (tokens: Tokens, id: string, body: object) =>
    http().post(`${API}/${id}/move`).set(as(tokens)).send(body);
  const history = (tokens: Tokens, id: string, query: object = {}) =>
    http().get(`${API}/${id}/history`).query(query).set(as(tokens));
  const stageId = (index: number): string => stages[index]?.id ?? '';
  const dealIn = (
    user: Pick<TestUser, 'id'>,
    index = 0,
    overrides: Parameters<typeof createDeal>[3] = {},
  ) =>
    createDeal(
      prisma,
      owned(orgA, user),
      { pipelineId: pipelineA.id, stageId: stageId(index) },
      overrides,
    );
  const row = (id: string) => prisma.deal.findUniqueOrThrow({ where: { id } });
  const historyRows = (dealId: string) =>
    prisma.dealStageHistory.findMany({ where: { dealId }, orderBy: { changedAt: 'asc' } });

  async function holdLock(kind: LockKind, id: string, mode: LockMode = 'exclusive') {
    let release!: () => void;
    let acquired!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const held = new Promise<void>((resolve) => (acquired = resolve));
    const done = prisma.$transaction(
      async (tx) => {
        await acquireLock(tx, kind, id, mode);
        acquired();
        await gate;
      },
      { timeout: 30_000 },
    );
    await held;
    return { release: () => release(), done };
  }
  const stillPendingAfter = async (promise: PromiseLike<unknown>, ms = 600): Promise<boolean> => {
    let settled = false;
    void Promise.resolve(promise).then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, ms));
    return !settled;
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = createTestPrisma();
    events = app.get(EventEmitter2);
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    orgA = await createOrganization(prisma, 'orga');
    orgB = await createOrganization(prisma, 'orgb');
    manager = await createUser(prisma, orgA, { role: ROLE_NAMES.SALES_MANAGER });
    report = await createUser(prisma, orgA, { managerId: manager.id });
    repX = await createUser(prisma, orgA);
    const readRole = await createCustomRole(prisma, orgA, 'Deals reader', ['deals:read']);
    readOnly = await createUser(prisma, orgA, { role: readRole.name });
    const noPermissions = await createCustomRole(prisma, orgA, 'Nobody', []);
    nobody = await createUser(prisma, orgA, { role: noPermissions.name });
    repB = await createUser(prisma, orgB);
    [adminT, managerT, reportT, repXT, readOnlyT, nobodyT, repBT] = await Promise.all(
      [orgA.admin, manager, report, repX, readOnly, nobody, repB].map(signIn),
    );
    pipelineA = await findDefaultPipeline(prisma, orgA.id);
    stages = pipelineA.stages;
  });

  afterEach(() => {
    events.removeAllListeners('deal.stage_changed');
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('authentication and permissions', () => {
    it('401 without a token', async () => {
      const deal = await dealIn(report);
      await http()
        .post(`${API}/${deal.id}/move`)
        .send({ stageId: stageId(1) })
        .expect(401);
      await http().get(`${API}/${deal.id}/history`).expect(401);
    });

    it('403 without deals:update for a move, without deals:read for the history', async () => {
      const deal = await dealIn(nobody);
      expect((await move(nobodyT, deal.id, { stageId: stageId(1) }).expect(403)).body.code).toBe(
        'FORBIDDEN',
      );
      await move(readOnlyT, deal.id, { stageId: stageId(1) }).expect(403);
      await history(nobodyT, deal.id).expect(403);
      await history(readOnlyT, deal.id).expect(404); // allowed to read, but the deal is not theirs
    });
  });

  describe('moves between open stages', () => {
    it('moves forward and backward; writes one history row per move with from, to and the actor', async () => {
      const deal = await dealIn(report);
      const forward = await move(reportT, deal.id, { stageId: stageId(2) }).expect(200);
      expect(forward.body).toMatchObject({
        id: deal.id,
        stageId: stageId(2),
        status: 'OPEN',
        closedAt: null,
        lostReason: null,
      });
      await move(reportT, deal.id, { stageId: stageId(1) }).expect(200);
      expect((await row(deal.id)).stageId).toBe(stageId(1));
      const rows = await historyRows(deal.id);
      expect(rows.map((r) => [r.fromStageId, r.toStageId, r.changedById])).toEqual([
        [stageId(0), stageId(2), report.id],
        [stageId(2), stageId(1), report.id],
      ]);
    });

    it('a manager moves a team member deal, recording the manager as the actor; an admin moves anyone deal', async () => {
      const deal = await dealIn(report);
      await move(managerT, deal.id, { stageId: stageId(1) }).expect(200);
      await move(adminT, deal.id, { stageId: stageId(2) }).expect(200);
      expect((await historyRows(deal.id)).map((r) => r.changedById)).toEqual([
        manager.id,
        orgA.admin.id,
      ]);
    });
  });

  describe('won, lost and reopening', () => {
    it('the Won stage wins the deal: WON, closedAt set, no reason; the history row exists', async () => {
      const deal = await dealIn(report, 3);
      const res = await move(reportT, deal.id, { stageId: stageId(4) }).expect(200);
      expect(res.body.status).toBe('WON');
      expect(res.body.closedAt).not.toBeNull();
      expect(res.body.lostReason).toBeNull();
      expect((await historyRows(deal.id)).at(-1)).toMatchObject({
        fromStageId: stageId(3),
        toStageId: stageId(4),
      });
    });

    it('the Lost stage needs a reason (trimmed, max 500); LOST, closedAt and reason are stored', async () => {
      const deal = await dealIn(report);
      for (const body of [
        { stageId: stageId(5) },
        { stageId: stageId(5), lostReason: '   ' },
        { stageId: stageId(5), lostReason: 'x'.repeat(501) },
      ]) {
        const res = await move(reportT, deal.id, body);
        expect(res.status).toBe(400);
      }
      const noReason = await move(reportT, deal.id, { stageId: stageId(5) });
      expect(noReason.body.code).toBe('LOST_REASON_REQUIRED');
      expect((await row(deal.id)).stageId).toBe(stageId(0));
      expect(await historyRows(deal.id)).toHaveLength(0);

      const res = await move(reportT, deal.id, {
        stageId: stageId(5),
        lostReason: '  Chose a competitor ',
      }).expect(200);
      expect(res.body).toMatchObject({ status: 'LOST', lostReason: 'Chose a competitor' });
      expect(res.body.closedAt).not.toBeNull();
    });

    it('a reason with a non-Lost target is 400 LOST_REASON_NOT_ALLOWED', async () => {
      const deal = await dealIn(report);
      for (const index of [1, 4]) {
        const res = await move(reportT, deal.id, { stageId: stageId(index), lostReason: 'why' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('LOST_REASON_NOT_ALLOWED');
      }
      expect((await row(deal.id)).stageId).toBe(stageId(0));
    });

    it('reopening a WON deal (move to an open stage) clears closedAt, keeps it OPEN, and writes history', async () => {
      const deal = await dealIn(report, 4, { status: 'WON' });
      await prisma.deal.update({ where: { id: deal.id }, data: { closedAt: new Date() } });
      const res = await move(reportT, deal.id, { stageId: stageId(2) }).expect(200);
      expect(res.body).toMatchObject({
        status: 'OPEN',
        closedAt: null,
        lostReason: null,
        stageId: stageId(2),
      });
      expect((await historyRows(deal.id)).at(-1)).toMatchObject({
        fromStageId: stageId(4),
        toStageId: stageId(2),
      });
    });

    it('reopening a LOST deal clears closedAt AND lostReason; the deal is editable again', async () => {
      const deal = await dealIn(report, 3);
      await move(reportT, deal.id, { stageId: stageId(5), lostReason: 'Budget cut' }).expect(200);
      await http().patch(`${API}/${deal.id}`).set(as(reportT)).send({ title: 'x' }).expect(409); // closed: read-only
      const reopened = await move(reportT, deal.id, { stageId: stageId(1) }).expect(200);
      expect(reopened.body).toMatchObject({ status: 'OPEN', closedAt: null, lostReason: null });
      const stored = await row(deal.id);
      expect([stored.status, stored.closedAt, stored.lostReason]).toEqual(['OPEN', null, null]);
      await http()
        .patch(`${API}/${deal.id}`)
        .set(as(reportT))
        .send({ title: 'Editable again' })
        .expect(200);
      expect((await historyRows(deal.id)).map((r) => r.toStageId)).toEqual([
        stageId(5),
        stageId(1),
      ]);
    });

    it('a closed deal can move straight to the other terminal stage (WON -> LOST needs a reason)', async () => {
      const deal = await dealIn(report, 4, { status: 'WON' });
      await move(reportT, deal.id, { stageId: stageId(5) }).expect(400);
      const res = await move(reportT, deal.id, { stageId: stageId(5), lostReason: 'Cancelled' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('LOST');
    });
  });

  describe('rejected moves change nothing', () => {
    it('409 INVALID_STAGE_MOVE for the stage the deal is already in; no history row', async () => {
      const deal = await dealIn(report);
      const res = await move(reportT, deal.id, { stageId: stageId(0) }).expect(409);
      expect(res.body.code).toBe('INVALID_STAGE_MOVE');
      expect(await historyRows(deal.id)).toHaveLength(0);
    });

    it('400 INVALID_STAGE for a stage of another pipeline, another organization or a missing one', async () => {
      const other = await createPipeline(prisma, { organizationId: orgA.id });
      const foreign = await findDefaultPipeline(prisma, orgB.id);
      const deal = await dealIn(report);
      for (const target of [other.stages[0]?.id, foreign.stages[0]?.id, MISSING_ID]) {
        const res = await move(reportT, deal.id, { stageId: target }).expect(400);
        expect(res.body.code).toBe('INVALID_STAGE');
      }
      expect((await row(deal.id)).stageId).toBe(stageId(0));
      expect(await historyRows(deal.id)).toHaveLength(0);
    });

    it('400 for a missing / malformed body and unknown fields (status, pipelineId)', async () => {
      const deal = await dealIn(report);
      await move(reportT, deal.id, {}).expect(400);
      await move(reportT, deal.id, { stageId: 'nope' }).expect(400);
      await move(reportT, deal.id, { stageId: stageId(1), status: 'WON' }).expect(400);
      await move(reportT, deal.id, { stageId: stageId(1), pipelineId: pipelineA.id }).expect(400);
      await move(reportT, deal.id, { stageId: stageId(1), lostReason: null }).expect(400);
    });

    it('404 for a deal the caller cannot see, one in another organization, a deleted one and a missing one', async () => {
      const hidden = await dealIn(repX);
      const deleted = await dealIn(report, 0, { deletedAt: new Date() });
      const foreignPipeline = await findDefaultPipeline(prisma, orgB.id);
      const foreign = await createDeal(
        prisma,
        owned(orgB, repB),
        { pipelineId: foreignPipeline.id, stageId: foreignPipeline.stages[0]?.id ?? '' },
        {},
      );
      for (const id of [hidden.id, deleted.id, foreign.id, MISSING_ID]) {
        const res = await move(reportT, id, { stageId: stageId(1) }).expect(404);
        expect(res.body.code).toBe('RESOURCE_NOT_FOUND');
      }
      expect((await row(hidden.id)).stageId).toBe(stageId(0));
      expect((await row(foreign.id)).stageId).toBe(foreignPipeline.stages[0]?.id);
      await move(repBT, hidden.id, { stageId: stageId(1) }).expect(404);
    });
  });

  describe('history', () => {
    it('lists newest first with stage names (and the creation row has no fromStage), exact shape', async () => {
      const created = await http()
        .post(API)
        .set(as(reportT))
        .send({ title: 'With history' })
        .expect(201);
      await move(reportT, created.body.id, { stageId: stageId(1) }).expect(200);
      await move(reportT, created.body.id, { stageId: stageId(2) }).expect(200);

      const res = await history(reportT, created.body.id).expect(200);
      expect(res.body.meta.total).toBe(3);
      expect(
        res.body.data.map(
          (r: { fromStage: { name: string } | null; toStage: { name: string } }) => [
            r.fromStage?.name ?? null,
            r.toStage.name,
          ],
        ),
      ).toEqual([
        ['Qualified', 'Proposal'],
        ['Prospecting', 'Qualified'],
        [null, 'Prospecting'],
      ]);
      expect(Object.keys(res.body.data[0]).sort()).toEqual([
        'changedAt',
        'changedById',
        'fromStage',
        'id',
        'toStage',
      ]);
      expect(Object.keys(res.body.data[0].toStage).sort()).toEqual(['id', 'name']);
      expect(res.body.data[0].changedById).toBe(report.id);
    });

    it('paginates, sorts ascending on request, and rejects an unknown sort field', async () => {
      const deal = await dealIn(report);
      for (const index of [1, 2, 3, 1, 2]) {
        await move(reportT, deal.id, { stageId: stageId(index) }).expect(200);
      }
      const page = await history(reportT, deal.id, { limit: 2, page: 2 }).expect(200);
      expect(page.body.data).toHaveLength(2);
      expect(page.body.meta).toMatchObject({ total: 5, totalPages: 3, page: 2 });
      const asc = await history(reportT, deal.id, { sortOrder: 'asc' }).expect(200);
      expect(asc.body.data[0].toStage.id).toBe(stageId(1));
      await history(reportT, deal.id, { sortBy: 'nonsense' }).expect(400);
    });

    it('follows the deal visibility: hidden, other organization, deleted and missing are all 404', async () => {
      const own = await dealIn(report);
      const hidden = await dealIn(repX);
      const deleted = await dealIn(report, 0, { deletedAt: new Date() });
      await history(reportT, own.id).expect(200);
      await history(managerT, own.id).expect(200); // the team
      await history(adminT, hidden.id).expect(200);
      for (const id of [hidden.id, deleted.id, MISSING_ID]) {
        await history(reportT, id).expect(404);
      }
      await history(repBT, own.id).expect(404);
    });

    it('still reads when the contact of the deal was deleted', async () => {
      const contact = await createContact(prisma, owned(orgA, report));
      const deal = await dealIn(report, 4, { status: 'WON', contactId: contact.id });
      await http().delete(`/api/v1/contacts/${contact.id}`).set(as(reportT)).expect(204);
      await history(reportT, deal.id).expect(200);
      await http().get(`${API}/${deal.id}`).set(as(reportT)).expect(200);
    });
  });

  describe('deal.stage_changed event', () => {
    it('is emitted once after the commit with ids and the resulting status only', async () => {
      const received: Record<string, unknown>[] = [];
      events.on('deal.stage_changed', (payload: Record<string, unknown>) => {
        received.push(payload);
      });
      const deal = await dealIn(report, 3, { title: 'Confidential title', amount: '777' });
      await move(reportT, deal.id, { stageId: stageId(4) }).expect(200);

      await vi.waitFor(() => expect(received).toHaveLength(1));
      expect(received[0]).toMatchObject({
        organizationId: orgA.id,
        dealId: deal.id,
        pipelineId: pipelineA.id,
        fromStageId: stageId(3),
        toStageId: stageId(4),
        status: 'WON',
        actorId: report.id,
      });
      expect(Object.keys(received[0] ?? {}).sort()).toEqual([
        'actorId',
        'changedAt',
        'dealId',
        'fromStageId',
        'organizationId',
        'pipelineId',
        'status',
        'toStageId',
      ]);
      expect(JSON.stringify(received[0])).not.toMatch(/Confidential|777/);
    });

    it('a listener that throws or rejects does not break the response', async () => {
      events.on('deal.stage_changed', () => {
        throw new Error('sync listener failed');
      });
      events.on('deal.stage_changed', () => Promise.reject(new Error('async listener failed')));
      const deal = await dealIn(report);
      const res = await move(reportT, deal.id, { stageId: stageId(1) }).expect(200);
      expect(res.body.stageId).toBe(stageId(1));
    });

    it('is not emitted for a rejected move', async () => {
      const received: unknown[] = [];
      events.on('deal.stage_changed', (payload: unknown) => {
        received.push(payload);
      });
      const deal = await dealIn(report);
      await move(reportT, deal.id, { stageId: stageId(0) }).expect(409);
      await move(reportT, deal.id, { stageId: stageId(5) }).expect(400);
      await move(reportT, deal.id, { stageId: MISSING_ID }).expect(400);
      await move(repXT, deal.id, { stageId: stageId(1) }).expect(404);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(received).toEqual([]);
    });
  });

  describe('races', () => {
    it('two moves of one deal in parallel: exactly one wins, one history row, the stage matches it', async () => {
      for (let i = 0; i < RACE_ITERATIONS; i += 1) {
        const deal = await dealIn(report);
        const results = await Promise.all([
          move(reportT, deal.id, { stageId: stageId(1) }),
          move(managerT, deal.id, { stageId: stageId(2) }),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
        const loser = results.find((r) => r.status === 409);
        expect(loser?.body.code).toBe('DEAL_STAGE_CHANGED');
        const rows = await historyRows(deal.id);
        expect(rows).toHaveLength(1);
        expect((await row(deal.id)).stageId).toBe(rows[0]?.toStageId);
      }
    });

    it('many parallel moves: every history row chains from the previous stage and ends at the stored stage', async () => {
      const deal = await dealIn(report);
      const results = await Promise.all(
        [1, 2, 3, 1, 2, 3].map((index) => move(reportT, deal.id, { stageId: stageId(index) })),
      );
      expect(results.every((r) => [200, 409].includes(r.status))).toBe(true);
      const rows = await historyRows(deal.id);
      expect(rows).toHaveLength(results.filter((r) => r.status === 200).length);
      let previous = stageId(0);
      for (const entry of rows) {
        expect(entry.fromStageId).toBe(previous);
        previous = entry.toStageId;
      }
      expect((await row(deal.id)).stageId).toBe(previous);
    });

    it('moving a deal into a stage vs. deleting that stage: exactly one wins, never a 500', async () => {
      for (let i = 0; i < RACE_ITERATIONS; i += 1) {
        const pipeline = await createPipeline(prisma, { organizationId: orgA.id });
        const [first, second] = pipeline.stages;
        const deal = await createDeal(prisma, owned(orgA, report), {
          pipelineId: pipeline.id,
          stageId: first?.id ?? '',
        });
        const [moved, removed] = await Promise.all([
          move(reportT, deal.id, { stageId: second?.id }),
          http().delete(`/api/v1/pipelines/${pipeline.id}/stages/${second?.id}`).set(as(adminT)),
        ]);
        expect([200, 400]).toContain(moved.status);
        expect([204, 409]).toContain(removed.status);
        expect(moved.status === 200).toBe(removed.status === 409);
        const stored = await row(deal.id);
        expect(await prisma.pipelineStage.count({ where: { id: stored.stageId } })).toBe(1);
      }
    });

    it('moving to Won vs. editing the deal: either the edit lands first, or it is DEAL_CLOSED, and the deal ends WON', async () => {
      for (let i = 0; i < RACE_ITERATIONS; i += 1) {
        const deal = await dealIn(report, 3);
        const [moved, edited] = await Promise.all([
          move(reportT, deal.id, { stageId: stageId(4) }),
          http()
            .patch(`${API}/${deal.id}`)
            .set(as(reportT))
            .send({ title: `Edit ${i}` }),
        ]);
        expect(moved.status).toBe(200);
        expect([200, 409]).toContain(edited.status);
        const stored = await row(deal.id);
        expect(stored.status).toBe('WON');
        expect(stored.title === `Edit ${i}`).toBe(edited.status === 200);
      }
    });
  });

  describe('locks', () => {
    it('a move waits for an EXCLUSIVE pipeline lock (a stage delete / reorder in flight)', async () => {
      const deal = await dealIn(report);
      const holder = await holdLock('pipeline', pipelineA.id);
      const pending = Promise.resolve(move(reportT, deal.id, { stageId: stageId(1) }));
      expect(await stillPendingAfter(pending)).toBe(true);
      holder.release();
      await holder.done;
      expect((await pending).status).toBe(200);
    });

    it('moves proceed while only SHARED pipeline locks are held, and do not wait for each other', async () => {
      const holder = await holdLock('pipeline', pipelineA.id, 'shared');
      const deals = await Promise.all([dealIn(report), dealIn(report), dealIn(report)]);
      const outcome = await Promise.race([
        Promise.all(deals.map((d) => move(reportT, d.id, { stageId: stageId(1) }))).then((all) =>
          all.map((r) => r.status),
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 4000)),
      ]);
      expect(outcome).toEqual([200, 200, 200]);
      holder.release();
      await holder.done;
    });
  });
});
