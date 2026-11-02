import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '../../prisma/seed/prisma-client';
import { ROLE_NAMES } from '../../prisma/seed/permissions';
import {
  acquireLock,
  type LockKind,
  type LockMode,
} from '../../src/infrastructure/prisma/advisory-lock';
import { createDeal, createPipeline, findDefaultPipeline } from '../factories/crm.factory';
import { createTestPrisma, resetDatabase } from '../factories/database';
import {
  createCustomRole,
  createOrganization,
  createUser,
  type TestOrganization,
  type TestUser,
} from '../factories/organization.factory';
import { createTestApp } from '../setup/create-test-app';

const API = '/api/v1/pipelines';
const RACE_ITERATIONS = 20;
const MISSING_ID = '11111111-1111-4111-8111-111111111111';

interface Tokens {
  accessToken: string;
}
interface Stage {
  id: string;
  name: string;
  position: number;
  probability: number;
  isWon: boolean;
  isLost: boolean;
}

describe('Pipelines (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let orgA: TestOrganization;
  let orgB: TestOrganization;
  let manager: TestUser;
  let rep: TestUser;
  let nobody: TestUser;
  let adminT: Tokens;
  let managerT: Tokens;
  let repT: Tokens;
  let nobodyT: Tokens;
  let adminBT: Tokens;

  const http = () => request(app.getHttpServer());
  const signIn = async ({ email, password }: Pick<TestUser, 'email' | 'password'>) =>
    (await http().post('/api/v1/auth/login').send({ email, password }).expect(200)).body as Tokens;
  const as = (tokens: Tokens) => ({ Authorization: `Bearer ${tokens.accessToken}` });
  const get = (tokens: Tokens, path = '') => http().get(`${API}${path}`).set(as(tokens));
  const post = (tokens: Tokens, path: string, body: object = {}) =>
    http().post(`${API}${path}`).set(as(tokens)).send(body);
  const patch = (tokens: Tokens, path: string, body: object) =>
    http().patch(`${API}${path}`).set(as(tokens)).send(body);
  const del = (tokens: Tokens, path: string) => http().delete(`${API}${path}`).set(as(tokens));
  const stagesOf = async (pipelineId: string): Promise<Stage[]> =>
    prisma.pipelineStage.findMany({ where: { pipelineId }, orderBy: { position: 'asc' } });
  const defaultsOf = (organizationId: string) =>
    prisma.pipeline.count({ where: { organizationId, isDefault: true } });
  const inOrg = (org: TestOrganization) => ({ organizationId: org.id });
  const owner = (org: TestOrganization) => ({ organizationId: org.id, ownerId: org.admin.id });

  // Holds an advisory lock in an open transaction until `release()`.
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
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    orgA = await createOrganization(prisma, 'orga');
    orgB = await createOrganization(prisma, 'orgb');
    manager = await createUser(prisma, orgA, { role: ROLE_NAMES.SALES_MANAGER });
    rep = await createUser(prisma, orgA);
    const noPermissions = await createCustomRole(prisma, orgA, 'Nobody', []);
    nobody = await createUser(prisma, orgA, { role: noPermissions.name });
    [adminT, managerT, repT, nobodyT, adminBT] = await Promise.all(
      [orgA.admin, manager, rep, nobody, orgB.admin].map(signIn),
    );
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('authentication and permissions', () => {
    it('401 without a token, on every route', async () => {
      const pipeline = await findDefaultPipeline(prisma, orgA.id);
      const stage = pipeline.stages[0]?.id ?? MISSING_ID;
      await http().get(API).expect(401);
      await http().get(`${API}/${pipeline.id}`).expect(401);
      await http().post(API).send({ name: 'x' }).expect(401);
      await http().patch(`${API}/${pipeline.id}`).send({ name: 'x' }).expect(401);
      await http().delete(`${API}/${pipeline.id}`).expect(401);
      await http().post(`${API}/${pipeline.id}/stages`).send({}).expect(401);
      await http().patch(`${API}/${pipeline.id}/stages/${stage}`).send({}).expect(401);
      await http().delete(`${API}/${pipeline.id}/stages/${stage}`).expect(401);
      await http().post(`${API}/${pipeline.id}/stages/reorder`).send({}).expect(401);
    });

    it('403 FORBIDDEN without any permission, on every route', async () => {
      const pipeline = await findDefaultPipeline(prisma, orgA.id);
      const stage = pipeline.stages[0]?.id ?? MISSING_ID;
      for (const res of [
        await get(nobodyT),
        await get(nobodyT, `/${pipeline.id}`),
        await post(nobodyT, '', { name: 'x' }),
        await patch(nobodyT, `/${pipeline.id}`, { name: 'x' }),
        await del(nobodyT, `/${pipeline.id}`),
        await post(nobodyT, `/${pipeline.id}/stages`, { name: 'x', probability: 1 }),
        await patch(nobodyT, `/${pipeline.id}/stages/${stage}`, { name: 'x' }),
        await del(nobodyT, `/${pipeline.id}/stages/${stage}`),
        await post(nobodyT, `/${pipeline.id}/stages/reorder`, { stageIds: [stage] }),
      ]) {
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('FORBIDDEN');
      }
    });

    it('a rep can read but not change anything', async () => {
      const pipeline = await findDefaultPipeline(prisma, orgA.id);
      await get(repT).expect(200);
      await get(repT, `/${pipeline.id}`).expect(200);
      await post(repT, '', { name: 'x' }).expect(403);
      await patch(repT, `/${pipeline.id}`, { name: 'x' }).expect(403);
      await del(repT, `/${pipeline.id}`).expect(403);
      await post(repT, `/${pipeline.id}/stages`, { name: 'x', probability: 1 }).expect(403);
    });

    it('a manager can create and edit pipelines and stages (organization-wide, ADR 0009) but not delete', async () => {
      const created = await post(managerT, '', { name: 'Managed' }).expect(201);
      await patch(managerT, `/${created.body.id}`, { name: 'Managed 2' }).expect(200);
      await post(managerT, `/${created.body.id}/stages`, { name: 'Extra', probability: 5 }).expect(
        201,
      );
      await del(managerT, `/${created.body.id}`).expect(403);
    });
  });

  describe('read', () => {
    it('lists the seeded default pipeline with stages in board order, exact shape', async () => {
      const res = await get(adminT).expect(200);
      expect(res.body.meta.total).toBe(1);
      const [pipeline] = res.body.data;
      expect(Object.keys(pipeline).sort()).toEqual([
        'createdAt',
        'id',
        'isDefault',
        'name',
        'stages',
        'updatedAt',
      ]);
      expect(pipeline.isDefault).toBe(true);
      expect(pipeline.stages.map((s: Stage) => [s.name, s.position, s.probability])).toEqual([
        ['Prospecting', 1, 10],
        ['Qualified', 2, 25],
        ['Proposal', 3, 50],
        ['Negotiation', 4, 75],
        ['Won', 5, 100],
        ['Lost', 6, 0],
      ]);
      expect(Object.keys(pipeline.stages[0]).sort()).toEqual([
        'id',
        'isLost',
        'isWon',
        'name',
        'position',
        'probability',
      ]);
    });

    it('paginates and sorts, and rejects an unknown sort field', async () => {
      await createPipeline(prisma, inOrg(orgA), { name: 'Alpha' });
      await createPipeline(prisma, inOrg(orgA), { name: 'Zulu' });
      const page = await get(adminT).query({ limit: 2, sortBy: 'name', sortOrder: 'asc' });
      expect(page.body.data.map((p: { name: string }) => p.name)).toEqual([
        'Alpha',
        'Sales Pipeline',
      ]);
      expect(page.body.meta.total).toBe(3);
      await get(adminT).query({ sortBy: 'nonsense' }).expect(400);
    });

    it('never shows another organization, and answers 404 for its pipeline', async () => {
      const own = await findDefaultPipeline(prisma, orgA.id);
      const foreign = await findDefaultPipeline(prisma, orgB.id);
      const list = await get(adminT).expect(200);
      expect(list.body.data.map((p: { id: string }) => p.id)).toEqual([own.id]);
      expect((await get(adminT, `/${foreign.id}`).expect(404)).body.code).toBe(
        'RESOURCE_NOT_FOUND',
      );
      await get(adminT, `/${MISSING_ID}`).expect(404);
      await get(adminT, '/not-a-uuid').expect(400);
    });
  });

  describe('create', () => {
    it('copies the default template when no stages are sent', async () => {
      const res = await post(adminT, '', { name: 'Copy' }).expect(201);
      expect(res.body.isDefault).toBe(false);
      expect(res.body.stages.map((s: Stage) => s.name)).toEqual([
        'Prospecting',
        'Qualified',
        'Proposal',
        'Negotiation',
        'Won',
        'Lost',
      ]);
    });

    it('appends Won (100) and Lost (0) with their markers to the given open stages', async () => {
      const res = await post(adminT, '', {
        name: '  Enterprise ',
        stages: [
          { name: ' Discovery ', probability: 5 },
          { name: 'Pilot', probability: 60 },
        ],
      }).expect(201);
      expect(res.body.name).toBe('Enterprise');
      const stages: Stage[] = res.body.stages;
      expect(stages.map((s) => [s.name, s.position, s.probability, s.isWon, s.isLost])).toEqual([
        ['Discovery', 1, 5, false, false],
        ['Pilot', 2, 60, false, false],
        ['Won', 3, 100, true, false],
        ['Lost', 4, 0, false, true],
      ]);
    });

    it.each([
      ['a terminal flag', { name: 'S', probability: 5, isWon: true }],
      ['a position', { name: 'S', probability: 5, position: 1 }],
      ['probability 100 on an open stage', { name: 'S', probability: 100 }],
      ['a negative probability', { name: 'S', probability: -1 }],
      ['a fractional probability', { name: 'S', probability: 5.5 }],
      ['a blank stage name', { name: '  ', probability: 5 }],
    ])('400 for %s', async (_label, stage) => {
      const res = await post(adminT, '', { name: 'Bad', stages: [stage] }).expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(await prisma.pipeline.count({ where: { name: 'Bad' } })).toBe(0);
    });

    it('400 for no stages in the array, too many stages and a blank name', async () => {
      await post(adminT, '', { name: 'Bad', stages: [] }).expect(400);
      const tooMany = Array.from({ length: 21 }, (_, i) => ({ name: `S${i}`, probability: 1 }));
      await post(adminT, '', { name: 'Bad', stages: tooMany }).expect(400);
      await post(adminT, '', { name: '   ' }).expect(400);
      await post(adminT, '', { name: 'Bad', stages: null }).expect(400);
    });

    it('409 for a repeated pipeline name (any case) and for repeated stage names (Won / Lost included)', async () => {
      const clash = await post(adminT, '', { name: 'sales pipeline' }).expect(409);
      expect(clash.body.code).toBe('PIPELINE_NAME_ALREADY_EXISTS');
      const dupes = await post(adminT, '', {
        name: 'Dupes',
        stages: [
          { name: 'A', probability: 1 },
          { name: 'a', probability: 2 },
        ],
      }).expect(409);
      expect(dupes.body.code).toBe('STAGE_NAME_ALREADY_EXISTS');
      const winLike = await post(adminT, '', {
        name: 'Dupes',
        stages: [{ name: 'WON', probability: 1 }],
      }).expect(409);
      expect(winLike.body.code).toBe('STAGE_NAME_ALREADY_EXISTS');
    });

    it('the same name is fine in another organization', async () => {
      await post(adminBT, '', { name: 'Shared name' }).expect(201);
      await post(adminT, '', { name: 'Shared name' }).expect(201);
    });
  });

  describe('update', () => {
    it('renames; trims; 409 on a clash; 400 on empty / null / isDefault false', async () => {
      const other = await createPipeline(prisma, inOrg(orgA), { name: 'Other' });
      const res = await patch(adminT, `/${other.id}`, { name: '  Renamed ' }).expect(200);
      expect(res.body.name).toBe('Renamed');
      expect(
        (await patch(adminT, `/${other.id}`, { name: 'SALES PIPELINE' }).expect(409)).body.code,
      ).toBe('PIPELINE_NAME_ALREADY_EXISTS');
      // Changing only the case of its own name is not a clash.
      await patch(adminT, `/${other.id}`, { name: 'RENAMED' }).expect(200);
      expect((await patch(adminT, `/${other.id}`, {}).expect(400)).body.code).toBe('EMPTY_UPDATE');
      await patch(adminT, `/${other.id}`, { name: null }).expect(400);
      await patch(adminT, `/${other.id}`, { isDefault: false }).expect(400);
      await patch(adminT, `/${other.id}`, { slug: 'x' }).expect(400);
    });

    it('makes another pipeline the default: exactly one default afterwards', async () => {
      const first = await findDefaultPipeline(prisma, orgA.id);
      const other = await createPipeline(prisma, inOrg(orgA), { name: 'Other' });
      const res = await patch(adminT, `/${other.id}`, { isDefault: true }).expect(200);
      expect(res.body.isDefault).toBe(true);
      expect(await defaultsOf(orgA.id)).toBe(1);
      expect((await prisma.pipeline.findUniqueOrThrow({ where: { id: first.id } })).isDefault).toBe(
        false,
      );
      // Idempotent for the current default.
      await patch(adminT, `/${other.id}`, { isDefault: true }).expect(200);
      expect(await defaultsOf(orgA.id)).toBe(1);
    });

    it('404 for another organization and a missing pipeline', async () => {
      const foreign = await findDefaultPipeline(prisma, orgB.id);
      await patch(adminT, `/${foreign.id}`, { name: 'x' }).expect(404);
      await patch(adminT, `/${MISSING_ID}`, { name: 'x' }).expect(404);
      expect((await prisma.pipeline.findUniqueOrThrow({ where: { id: foreign.id } })).name).toBe(
        'Sales Pipeline',
      );
    });
  });

  describe('delete', () => {
    it('204 for a pipeline without deals; its stages go with it', async () => {
      const other = await createPipeline(prisma, inOrg(orgA));
      await del(adminT, `/${other.id}`).expect(204);
      expect(await prisma.pipeline.count({ where: { id: other.id } })).toBe(0);
      expect(await prisma.pipelineStage.count({ where: { pipelineId: other.id } })).toBe(0);
    });

    it('409 PIPELINE_IS_DEFAULT for the default pipeline', async () => {
      const own = await findDefaultPipeline(prisma, orgA.id);
      expect((await del(adminT, `/${own.id}`).expect(409)).body.code).toBe('PIPELINE_IS_DEFAULT');
    });

    it('409 PIPELINE_HAS_DEALS with a live deal AND with a soft-deleted deal (the foreign key still holds)', async () => {
      const withLive = await createPipeline(prisma, inOrg(orgA));
      await createDeal(prisma, owner(orgA), {
        pipelineId: withLive.id,
        stageId: withLive.stages[0]?.id ?? '',
      });
      const withDeleted = await createPipeline(prisma, inOrg(orgA));
      await createDeal(
        prisma,
        owner(orgA),
        { pipelineId: withDeleted.id, stageId: withDeleted.stages[0]?.id ?? '' },
        { deletedAt: new Date() },
      );
      for (const pipeline of [withLive, withDeleted]) {
        const res = await del(adminT, `/${pipeline.id}`).expect(409);
        expect(res.body.code).toBe('PIPELINE_HAS_DEALS');
        expect(await prisma.pipeline.count({ where: { id: pipeline.id } })).toBe(1);
      }
    });

    it('404 for another organization; nothing is deleted', async () => {
      const foreign = await createPipeline(prisma, inOrg(orgB));
      await del(adminT, `/${foreign.id}`).expect(404);
      expect(await prisma.pipeline.count({ where: { id: foreign.id } })).toBe(1);
    });
  });

  describe('stages', () => {
    it('adds an open stage after the last open one; Won and Lost shift down', async () => {
      const own = await findDefaultPipeline(prisma, orgA.id);
      const res = await post(adminT, `/${own.id}/stages`, { name: ' Contract ', probability: 90 });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ name: 'Contract', position: 5, probability: 90 });
      expect((await stagesOf(own.id)).map((s) => [s.name, s.position])).toEqual([
        ['Prospecting', 1],
        ['Qualified', 2],
        ['Proposal', 3],
        ['Negotiation', 4],
        ['Contract', 5],
        ['Won', 6],
        ['Lost', 7],
      ]);
    });

    it('400 for bad input and TOO_MANY_STAGES, 409 for a repeated name, 404 elsewhere', async () => {
      const own = await findDefaultPipeline(prisma, orgA.id);
      await post(adminT, `/${own.id}/stages`, { name: 'x', probability: 100 }).expect(400);
      await post(adminT, `/${own.id}/stages`, { name: 'x', probability: 1, isWon: true }).expect(
        400,
      );
      expect(
        (await post(adminT, `/${own.id}/stages`, { name: 'proposal', probability: 1 }).expect(409))
          .body.code,
      ).toBe('STAGE_NAME_ALREADY_EXISTS');
      await post(adminT, `/${MISSING_ID}/stages`, { name: 'x', probability: 1 }).expect(404);
      const foreign = await findDefaultPipeline(prisma, orgB.id);
      await post(adminT, `/${foreign.id}/stages`, { name: 'x', probability: 1 }).expect(404);

      for (let i = 0; i < 16; i += 1) {
        await post(adminT, `/${own.id}/stages`, { name: `Extra ${i}`, probability: 1 }).expect(201);
      }
      const full = await post(adminT, `/${own.id}/stages`, { name: 'One more', probability: 1 });
      expect(full.status).toBe(400);
      expect(full.body.code).toBe('TOO_MANY_STAGES');
    });

    it('edits name and probability of an open stage; Won / Lost can be renamed but their probability is fixed', async () => {
      const own = await findDefaultPipeline(prisma, orgA.id);
      const [prospecting, , , , won] = own.stages;
      const edited = await patch(adminT, `/${own.id}/stages/${prospecting?.id}`, {
        name: 'Lead-in',
        probability: 15,
      }).expect(200);
      expect(edited.body).toMatchObject({ name: 'Lead-in', probability: 15, position: 1 });
      await patch(adminT, `/${own.id}/stages/${won?.id}`, { name: 'Closed won' }).expect(200);
      const fixed = await patch(adminT, `/${own.id}/stages/${won?.id}`, { probability: 90 });
      expect(fixed.status).toBe(400);
      expect(fixed.body.code).toBe('TERMINAL_STAGE_PROBABILITY_FIXED');
      await patch(adminT, `/${own.id}/stages/${prospecting?.id}`, { probability: 100 }).expect(400);
      await patch(adminT, `/${own.id}/stages/${prospecting?.id}`, { isWon: true }).expect(400);
      await patch(adminT, `/${own.id}/stages/${prospecting?.id}`, {}).expect(400);
      expect(
        (
          await patch(adminT, `/${own.id}/stages/${prospecting?.id}`, { name: 'QUALIFIED' }).expect(
            409,
          )
        ).body.code,
      ).toBe('STAGE_NAME_ALREADY_EXISTS');
    });

    it('404 for a stage of another pipeline or organization', async () => {
      const own = await findDefaultPipeline(prisma, orgA.id);
      const other = await createPipeline(prisma, inOrg(orgA));
      const foreign = await findDefaultPipeline(prisma, orgB.id);
      for (const stageId of [other.stages[0]?.id, foreign.stages[0]?.id, MISSING_ID]) {
        await patch(adminT, `/${own.id}/stages/${stageId}`, { name: 'x' }).expect(404);
        await del(adminT, `/${own.id}/stages/${stageId}`).expect(404);
      }
      expect((await stagesOf(foreign.id)).map((s) => s.name)).not.toContain('x');
    });

    it('deletes an open stage and closes the position gap', async () => {
      const own = await findDefaultPipeline(prisma, orgA.id);
      await del(adminT, `/${own.id}/stages/${own.stages[1]?.id}`).expect(204);
      expect((await stagesOf(own.id)).map((s) => [s.name, s.position])).toEqual([
        ['Prospecting', 1],
        ['Proposal', 2],
        ['Negotiation', 3],
        ['Won', 4],
        ['Lost', 5],
      ]);
    });

    it('409 TERMINAL_STAGE_REQUIRED for Won and Lost, PIPELINE_NEEDS_OPEN_STAGE for the last open stage', async () => {
      const own = await findDefaultPipeline(prisma, orgA.id);
      for (const stage of own.stages.slice(-2)) {
        const res = await del(adminT, `/${own.id}/stages/${stage.id}`).expect(409);
        expect(res.body.code).toBe('TERMINAL_STAGE_REQUIRED');
      }
      const single = await createPipeline(prisma, inOrg(orgA), {
        openStages: [{ name: 'Only', probability: 5 }],
      });
      const res = await del(adminT, `/${single.id}/stages/${single.stages[0]?.id}`).expect(409);
      expect(res.body.code).toBe('PIPELINE_NEEDS_OPEN_STAGE');
    });

    it('409 STAGE_IN_USE for a stage with a live deal, a soft-deleted deal, or only history', async () => {
      const pipeline = await createPipeline(prisma, inOrg(orgA), {
        openStages: [
          { name: 'Live', probability: 5 },
          { name: 'Deleted', probability: 5 },
          { name: 'History', probability: 5 },
          { name: 'Free', probability: 5 },
        ],
      });
      const [live, deleted, history, free] = pipeline.stages;
      const placement = (stageId?: string) => ({
        pipelineId: pipeline.id,
        stageId: stageId ?? '',
      });
      await createDeal(prisma, owner(orgA), placement(live?.id));
      await createDeal(prisma, owner(orgA), placement(deleted?.id), { deletedAt: new Date() });
      const moved = await createDeal(prisma, owner(orgA), placement(free?.id));
      await prisma.dealStageHistory.create({
        data: {
          organizationId: orgA.id,
          dealId: moved.id,
          fromStageId: history?.id,
          toStageId: free?.id ?? '',
          changedById: orgA.admin.id,
        },
      });
      for (const stage of [live, deleted, history]) {
        const res = await del(adminT, `/${pipeline.id}/stages/${stage?.id}`).expect(409);
        expect(res.body.code).toBe('STAGE_IN_USE');
      }
      expect(await prisma.pipelineStage.count({ where: { pipelineId: pipeline.id } })).toBe(6);
    });

    it('reorders the open stages; Won and Lost stay last', async () => {
      const own = await findDefaultPipeline(prisma, orgA.id);
      const open = own.stages.slice(0, 4).map((s) => s.id);
      const res = await post(adminT, `/${own.id}/stages/reorder`, {
        stageIds: [open[3], open[0], open[2], open[1]],
      }).expect(200);
      expect(res.body.stages.map((s: Stage) => [s.name, s.position])).toEqual([
        ['Negotiation', 1],
        ['Prospecting', 2],
        ['Proposal', 3],
        ['Qualified', 4],
        ['Won', 5],
        ['Lost', 6],
      ]);
    });

    it('400 INVALID_STAGE_ORDER for a missing, extra, terminal, foreign or repeated id', async () => {
      const own = await findDefaultPipeline(prisma, orgA.id);
      const foreign = await findDefaultPipeline(prisma, orgB.id);
      const open = own.stages.slice(0, 4).map((s) => s.id);
      for (const stageIds of [
        open.slice(0, 3),
        [...open, own.stages[4]?.id],
        [...open.slice(0, 3), foreign.stages[0]?.id],
        [...open.slice(0, 3), MISSING_ID],
      ]) {
        const res = await post(adminT, `/${own.id}/stages/reorder`, { stageIds }).expect(400);
        expect(res.body.code).toBe('INVALID_STAGE_ORDER');
      }
      await post(adminT, `/${own.id}/stages/reorder`, {
        stageIds: [open[0], open[0], open[1], open[2]],
      }).expect(400);
      expect((await stagesOf(own.id)).map((s) => s.name)).toEqual([
        'Prospecting',
        'Qualified',
        'Proposal',
        'Negotiation',
        'Won',
        'Lost',
      ]);
    });
  });

  describe('database guarantees (migration pipeline_stage_terminal_constraints)', () => {
    it('refuses a second Won stage, a second Lost stage and a stage that is both', async () => {
      const pipeline = await findDefaultPipeline(prisma, orgA.id);
      const make = (data: { isWon?: boolean; isLost?: boolean; name: string }) =>
        prisma.pipelineStage.create({
          data: {
            organizationId: orgA.id,
            pipelineId: pipeline.id,
            position: 9,
            probability: 0,
            ...data,
          },
        });
      await expect(make({ name: 'Second won', isWon: true })).rejects.toThrow();
      await expect(make({ name: 'Second lost', isLost: true })).rejects.toThrow();
      await expect(make({ name: 'Both', isWon: true, isLost: true })).rejects.toThrow();
      expect(await prisma.pipelineStage.count({ where: { pipelineId: pipeline.id } })).toBe(6);
    });

    it('another pipeline can have its own Won and Lost stage', async () => {
      const other = await createPipeline(prisma, inOrg(orgA));
      expect(other.stages.filter((s) => s.isWon || s.isLost)).toHaveLength(2);
    });
  });

  // The invariants, whoever wins. The lock behaviour itself is pinned by the `locks` tests below.
  describe('races', () => {
    it('parallel creates with the same name: exactly one wins', async () => {
      for (let i = 0; i < RACE_ITERATIONS; i += 1) {
        const results = await Promise.all([
          post(adminT, '', { name: `Race ${i}` }),
          post(managerT, '', { name: `RACE ${i}` }),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
        expect(
          await prisma.pipeline.count({
            where: { name: { equals: `race ${i}`, mode: 'insensitive' } },
          }),
        ).toBe(1);
      }
    });

    it('parallel default switches always leave exactly one default', async () => {
      const a = await createPipeline(prisma, inOrg(orgA), { name: 'A' });
      const b = await createPipeline(prisma, inOrg(orgA), { name: 'B' });
      for (let i = 0; i < RACE_ITERATIONS; i += 1) {
        const results = await Promise.all([
          patch(adminT, `/${a.id}`, { isDefault: true }),
          patch(managerT, `/${b.id}`, { isDefault: true }),
        ]);
        expect(results.map((r) => r.status)).toEqual([200, 200]);
        expect(await defaultsOf(orgA.id)).toBe(1);
      }
    });

    it('deleting a pipeline while it becomes the default never leaves the organization without one', async () => {
      for (let i = 0; i < RACE_ITERATIONS; i += 1) {
        const target = await createPipeline(prisma, inOrg(orgA));
        const results = await Promise.all([
          del(adminT, `/${target.id}`),
          patch(adminT, `/${target.id}`, { isDefault: true }),
        ]);
        expect([204, 409]).toContain(results[0].status);
        expect([200, 404]).toContain(results[1].status);
        expect(await defaultsOf(orgA.id)).toBe(1);
        // Put the original default back for the next round.
        const original = await prisma.pipeline.findFirstOrThrow({
          where: { organizationId: orgA.id, name: 'Sales Pipeline' },
        });
        await patch(adminT, `/${original.id}`, { isDefault: true }).expect(200);
        await prisma.pipeline.deleteMany({ where: { id: target.id } });
      }
    });

    it('parallel stage adds and a reorder keep positions 1..n, unique, with Won and Lost last', async () => {
      for (let i = 0; i < RACE_ITERATIONS; i += 1) {
        const pipeline = await createPipeline(prisma, inOrg(orgA), {
          openStages: [
            { name: 'One', probability: 1 },
            { name: 'Two', probability: 2 },
          ],
        });
        const [one, two] = pipeline.stages;
        const results = await Promise.all([
          post(adminT, `/${pipeline.id}/stages`, { name: 'Add 1', probability: 1 }),
          post(managerT, `/${pipeline.id}/stages`, { name: 'Add 2', probability: 2 }),
          post(adminT, `/${pipeline.id}/stages/reorder`, { stageIds: [two?.id, one?.id] }),
        ]);
        // The reorder lists two stages: it fails if an add came first (the open set changed).
        expect([200, 400]).toContain(results[2].status);
        expect(results[0].status).toBe(201);
        expect(results[1].status).toBe(201);
        const stages = await stagesOf(pipeline.id);
        expect(stages.map((s) => s.position)).toEqual(stages.map((_, index) => index + 1));
        expect(stages.slice(-2).map((s) => [s.isWon, s.isLost])).toEqual([
          [true, false],
          [false, true],
        ]);
        expect(stages).toHaveLength(6);
      }
    });
  });

  // Deterministic proof of the locks and their modes. Each fails if the lock it names is removed.
  describe('locks', () => {
    it('adding a stage waits for the pipeline lock', async () => {
      const pipeline = await createPipeline(prisma, inOrg(orgA));
      const holder = await holdLock('pipeline', pipeline.id);
      const pending = Promise.resolve(
        post(adminT, `/${pipeline.id}/stages`, { name: 'X', probability: 1 }),
      );
      expect(await stillPendingAfter(pending)).toBe(true);
      holder.release();
      await holder.done;
      expect((await pending).status).toBe(201);
    });

    it('deleting a stage and reordering also wait for the pipeline lock', async () => {
      const pipeline = await createPipeline(prisma, inOrg(orgA));
      const [one, two] = pipeline.stages;
      const holder = await holdLock('pipeline', pipeline.id);
      const removal = Promise.resolve(del(adminT, `/${pipeline.id}/stages/${one?.id}`));
      const reorder = Promise.resolve(
        post(adminT, `/${pipeline.id}/stages/reorder`, { stageIds: [two?.id, one?.id] }),
      );
      expect(await stillPendingAfter(Promise.all([removal, reorder]))).toBe(true);
      holder.release();
      await holder.done;
      await Promise.all([removal, reorder]);
    });

    it('deleting a pipeline waits for its pipeline lock; creating one and switching the default wait for the org lock', async () => {
      const pipeline = await createPipeline(prisma, inOrg(orgA));
      const pipelineHolder = await holdLock('pipeline', pipeline.id);
      const deletion = Promise.resolve(del(adminT, `/${pipeline.id}`));
      expect(await stillPendingAfter(deletion)).toBe(true);
      pipelineHolder.release();
      await pipelineHolder.done;
      expect((await deletion).status).toBe(204);

      const other = await createPipeline(prisma, inOrg(orgA));
      const orgHolder = await holdLock('org', orgA.id);
      const creation = Promise.resolve(post(adminT, '', { name: 'Waits' }));
      const switching = Promise.resolve(patch(adminT, `/${other.id}`, { isDefault: true }));
      expect(await stillPendingAfter(Promise.all([creation, switching]))).toBe(true);
      orgHolder.release();
      await orgHolder.done;
      expect((await creation).status).toBe(201);
      expect((await switching).status).toBe(200);
    });

    it('a SHARED pipeline lock does not block a second shared holder but blocks structure changes', async () => {
      const pipeline = await createPipeline(prisma, inOrg(orgA));
      const first = await holdLock('pipeline', pipeline.id, 'shared');

      // A second shared acquirer gets in at once.
      const second = await Promise.race([
        holdLock('pipeline', pipeline.id, 'shared').then((h) => ({ h })),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
      ]);
      expect(second).not.toBeNull();

      // An exclusive structure change waits for BOTH.
      const pending = Promise.resolve(
        post(adminT, `/${pipeline.id}/stages`, { name: 'X', probability: 1 }),
      );
      expect(await stillPendingAfter(pending)).toBe(true);
      first.release();
      await first.done;
      expect(await stillPendingAfter(pending, 400)).toBe(true);
      second?.h.release();
      await second?.h.done;
      expect((await pending).status).toBe(201);
    });

    it('an EXCLUSIVE holder blocks a shared acquirer', async () => {
      const pipeline = await createPipeline(prisma, inOrg(orgA));
      const exclusive = await holdLock('pipeline', pipeline.id);
      const shared = holdLock('pipeline', pipeline.id, 'shared');
      expect(await stillPendingAfter(shared)).toBe(true);
      exclusive.release();
      await exclusive.done;
      const acquired = await shared;
      acquired.release();
      await acquired.done;
    });
  });

  describe('seed', () => {
    it('onboarding creates the default pipeline once with positions 1..6 and exactly one Won / Lost', async () => {
      const pipeline = await findDefaultPipeline(prisma, orgA.id);
      expect(pipeline.stages.map((s) => s.position)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(pipeline.stages.filter((s) => s.isWon)).toHaveLength(1);
      expect(pipeline.stages.filter((s) => s.isLost)).toHaveLength(1);
    });
  });
});
