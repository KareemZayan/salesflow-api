import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '../../prisma/seed/prisma-client';
import { ROLE_NAMES } from '../../prisma/seed/permissions';
import {
  acquireLock,
  type LockKind,
  type LockMode,
} from '../../src/infrastructure/prisma/advisory-lock';
import {
  createCompany,
  createContact,
  createDeal,
  createLead,
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

describe('Deals (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let orgA: TestOrganization;
  let orgB: TestOrganization;
  let manager: TestUser;
  let report: TestUser;
  let repX: TestUser; // outside the manager's team
  let nobody: TestUser;
  let repB: TestUser;
  let adminT: Tokens;
  let managerT: Tokens;
  let reportT: Tokens;
  let nobodyT: Tokens;
  let repBT: Tokens;
  // The default pipeline of orgA: [Prospecting, Qualified, Proposal, Negotiation, Won, Lost].
  let pipelineA: Awaited<ReturnType<typeof findDefaultPipeline>>;

  const http = () => request(app.getHttpServer());
  const signIn = async ({ email, password }: Pick<TestUser, 'email' | 'password'>) =>
    (await http().post('/api/v1/auth/login').send({ email, password }).expect(200)).body as Tokens;
  const as = (tokens: Tokens) => ({ Authorization: `Bearer ${tokens.accessToken}` });
  const owned = (org: TestOrganization, user: Pick<TestUser, 'id'>) => ({
    organizationId: org.id,
    ownerId: user.id,
  });
  const post = (tokens: Tokens, body: object) => http().post(API).set(as(tokens)).send(body);
  const patch = (tokens: Tokens, id: string, body: object) =>
    http().patch(`${API}/${id}`).set(as(tokens)).send(body);
  const del = (tokens: Tokens, id: string) => http().delete(`${API}/${id}`).set(as(tokens));
  const placement = (pipeline: typeof pipelineA, index = 0) => ({
    pipelineId: pipeline.id,
    stageId: pipeline.stages[index]?.id ?? '',
  });
  const dealRow = (id: string) => prisma.deal.findUniqueOrThrow({ where: { id } });
  const dealCount = () => prisma.deal.count();
  const historyCount = () => prisma.dealStageHistory.count();
  const ids = (res: request.Response): string[] =>
    (res.body.data as { id: string }[]).map(({ id }) => id).sort();

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
    await prisma.organization.update({ where: { id: orgA.id }, data: { defaultCurrency: 'EGP' } });
    manager = await createUser(prisma, orgA, { role: ROLE_NAMES.SALES_MANAGER });
    report = await createUser(prisma, orgA, { managerId: manager.id });
    repX = await createUser(prisma, orgA);
    const noPermissions = await createCustomRole(prisma, orgA, 'Nobody', []);
    nobody = await createUser(prisma, orgA, { role: noPermissions.name });
    repB = await createUser(prisma, orgB);
    [adminT, managerT, reportT, nobodyT, repBT] = await Promise.all(
      [orgA.admin, manager, report, nobody, repB].map(signIn),
    );
    pipelineA = await findDefaultPipeline(prisma, orgA.id);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('authentication and permissions', () => {
    it('401 without a token, on every route', async () => {
      const deal = await createDeal(prisma, owned(orgA, report), placement(pipelineA));
      await http().get(API).expect(401);
      await http().get(`${API}/${deal.id}`).expect(401);
      await http().post(API).send({ title: 'x' }).expect(401);
      await http().patch(`${API}/${deal.id}`).send({ title: 'x' }).expect(401);
      await http().delete(`${API}/${deal.id}`).expect(401);
    });

    it('403 FORBIDDEN without the matching permission, on every route', async () => {
      const deal = await createDeal(prisma, owned(orgA, nobody), placement(pipelineA));
      for (const res of [
        await http().get(API).set(as(nobodyT)),
        await http().get(`${API}/${deal.id}`).set(as(nobodyT)),
        await post(nobodyT, { title: 'x' }),
        await patch(nobodyT, deal.id, { title: 'x' }),
        await del(nobodyT, deal.id),
      ]) {
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('FORBIDDEN');
      }
    });
  });

  describe('create', () => {
    it('201: first open stage of the default pipeline, organization currency, amount 0.00, owner = caller, exact shape', async () => {
      const res = await post(reportT, { title: '  Globex licence ' }).expect(201);
      expect(res.body).toMatchObject({
        title: 'Globex licence',
        amount: '0.00',
        currency: 'EGP',
        expectedCloseDate: null,
        status: 'OPEN',
        lostReason: null,
        closedAt: null,
        pipelineId: pipelineA.id,
        stageId: pipelineA.stages[0]?.id,
        contactId: null,
        companyId: null,
        ownerId: report.id,
      });
      expect(Object.keys(res.body).sort()).toEqual([
        'amount',
        'closedAt',
        'companyId',
        'contactId',
        'createdAt',
        'currency',
        'expectedCloseDate',
        'id',
        'lostReason',
        'ownerId',
        'pipelineId',
        'stageId',
        'status',
        'title',
        'updatedAt',
      ]);
    });

    it('writes the first stage-history row in the same transaction', async () => {
      const res = await post(reportT, { title: 'x' }).expect(201);
      const history = await prisma.dealStageHistory.findMany({ where: { dealId: res.body.id } });
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        fromStageId: null,
        toStageId: pipelineA.stages[0]?.id,
        changedById: report.id,
        organizationId: orgA.id,
      });
    });

    it('takes explicit money, currency (case-insensitive), close date, pipeline and stage', async () => {
      const other = await createPipeline(prisma, { organizationId: orgA.id });
      const res = await post(reportT, {
        title: 'Explicit',
        amount: '1250.5',
        currency: ' eur ',
        expectedCloseDate: '2026-12-31',
        pipelineId: other.id,
        stageId: other.stages[1]?.id,
      }).expect(201);
      expect(res.body).toMatchObject({
        amount: '1250.50',
        currency: 'EUR',
        expectedCloseDate: '2026-12-31',
        pipelineId: other.id,
        stageId: other.stages[1]?.id,
      });
    });

    it.each(['0', '0.00', '5', '999999999999.99', '12.3'])(
      'accepts the amount %s',
      async (amount) => {
        const res = await post(reportT, { title: 'x', amount }).expect(201);
        expect(Number(res.body.amount)).toBe(Number(amount));
        expect(res.body.amount).toMatch(/^\d+\.\d{2}$/);
      },
    );

    it.each([
      ['a JSON number', 1250],
      ['a JSON decimal number', 12.5],
      ['an exponent', '1e3'],
      ['a negative amount', '-5'],
      ['a third decimal', '1.234'],
      ['a thousands separator', '1,000'],
      ['a leading space', ' 5'],
      ['text', 'abc'],
      ['an empty string', ''],
      ['13 integer digits', '1000000000000'],
      ['null', null],
    ])('400 for %s as the amount; nothing is created', async (_label, amount) => {
      const res = await post(reportT, { title: 'x', amount }).expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(await dealCount()).toBe(0);
    });

    it.each([
      ['an unknown currency', { currency: 'XXY' }],
      ['a null currency', { currency: null }],
      ['a blank title', { title: '  ' }],
      ['an impossible date', { expectedCloseDate: '2026-02-31' }],
      ['a date with a time', { expectedCloseDate: '2026-12-31T10:00:00Z' }],
      ['a status', { status: 'WON' }],
      ['closedAt', { closedAt: '2026-01-01' }],
      ['a lost reason', { lostReason: 'x' }],
      ['a non-uuid pipelineId', { pipelineId: 'nope' }],
    ])('400 for %s', async (_label, extra) => {
      const body = { title: 'x', ...extra };
      const res = await post(reportT, body).expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('400 INVALID_STAGE for a Won / Lost stage and for a stage of another pipeline', async () => {
      const other = await createPipeline(prisma, { organizationId: orgA.id });
      for (const stageId of [
        pipelineA.stages[4]?.id,
        pipelineA.stages[5]?.id,
        other.stages[0]?.id,
        MISSING_ID,
      ]) {
        const res = await post(reportT, { title: 'x', stageId }).expect(400);
        expect(res.body.code).toBe('INVALID_STAGE');
      }
      expect(await dealCount()).toBe(0);
    });

    it('400 INVALID_PIPELINE for a missing pipeline and one of another organization', async () => {
      const foreign = await findDefaultPipeline(prisma, orgB.id);
      for (const pipelineId of [MISSING_ID, foreign.id]) {
        const res = await post(reportT, { title: 'x', pipelineId }).expect(400);
        expect(res.body.code).toBe('INVALID_PIPELINE');
      }
      const foreignStage = await post(reportT, {
        title: 'x',
        stageId: (await findDefaultPipeline(prisma, orgB.id)).stages[0]?.id,
      });
      expect(foreignStage.status).toBe(400);
      expect(foreignStage.body.code).toBe('INVALID_STAGE');
      expect(await dealCount()).toBe(0);
    });

    it('links a visible contact and company', async () => {
      const contact = await createContact(prisma, owned(orgA, report));
      const company = await createCompany(prisma, owned(orgA, report));
      const res = await post(reportT, {
        title: 'x',
        contactId: contact.id,
        companyId: company.id,
      }).expect(201);
      expect(res.body).toMatchObject({ contactId: contact.id, companyId: company.id });
    });

    it('400 INVALID_CONTACT / INVALID_COMPANY for foreign, hidden, deleted and missing records; nothing is left behind', async () => {
      const foreignContact = await createContact(prisma, owned(orgB, repB));
      const hiddenContact = await createContact(prisma, owned(orgA, repX));
      const deletedContact = await createContact(prisma, owned(orgA, report), {
        deletedAt: new Date(),
      });
      for (const contactId of [
        foreignContact.id,
        hiddenContact.id,
        deletedContact.id,
        MISSING_ID,
      ]) {
        const res = await post(reportT, { title: 'x', contactId }).expect(400);
        expect(res.body.code).toBe('INVALID_CONTACT');
      }
      const foreignCompany = await createCompany(prisma, owned(orgB, repB));
      const hiddenCompany = await createCompany(prisma, owned(orgA, repX));
      const deletedCompany = await createCompany(prisma, owned(orgA, report), {
        deletedAt: new Date(),
      });
      for (const companyId of [
        foreignCompany.id,
        hiddenCompany.id,
        deletedCompany.id,
        MISSING_ID,
      ]) {
        const res = await post(reportT, { title: 'x', companyId }).expect(400);
        expect(res.body.code).toBe('INVALID_COMPANY');
      }
      expect(await dealCount()).toBe(0);
      expect(await historyCount()).toBe(0);
    });

    it('a failing link after a valid one rolls the whole creation back (no deal, no history)', async () => {
      const company = await createCompany(prisma, owned(orgA, report));
      const hidden = await createContact(prisma, owned(orgA, repX));
      await post(reportT, { title: 'x', companyId: company.id, contactId: hidden.id }).expect(400);
      expect(await dealCount()).toBe(0);
      expect(await historyCount()).toBe(0);
    });

    it('owner: a rep cannot assign to someone else; a manager can within the team; an admin anywhere', async () => {
      const denied = await post(reportT, { title: 'x', ownerId: repX.id }).expect(400);
      expect(denied.body.code).toBe('INVALID_OWNER');
      await post(managerT, { title: 'x', ownerId: report.id }).expect(201);
      expect((await post(managerT, { title: 'x', ownerId: repX.id }).expect(400)).body.code).toBe(
        'INVALID_OWNER',
      );
      await post(adminT, { title: 'x', ownerId: repX.id }).expect(201);
    });
  });

  describe('read, visibility and tenant isolation', () => {
    it('a rep sees own deals, a manager own + team, an admin everyone; never another organization', async () => {
      const own = await createDeal(prisma, owned(orgA, report), placement(pipelineA));
      const managers = await createDeal(prisma, owned(orgA, manager), placement(pipelineA));
      const stranger = await createDeal(prisma, owned(orgA, repX), placement(pipelineA));
      const foreignPipeline = await findDefaultPipeline(prisma, orgB.id);
      const foreign = await createDeal(prisma, owned(orgB, repB), placement(foreignPipeline));

      const list = (tokens: Tokens) => http().get(API).set(as(tokens)).expect(200);
      expect(ids(await list(reportT))).toEqual([own.id]);
      expect(ids(await list(managerT))).toEqual([own.id, managers.id].sort());
      expect(ids(await list(adminT))).toEqual([own.id, managers.id, stranger.id].sort());
      expect(ids(await list(repBT))).toEqual([foreign.id]);

      await http().get(`${API}/${stranger.id}`).set(as(reportT)).expect(404);
      await http().get(`${API}/${foreign.id}`).set(as(adminT)).expect(404);
      await http().get(`${API}/${MISSING_ID}`).set(as(adminT)).expect(404);
    });

    it('filters, sorts, searches and paginates; filters only narrow', async () => {
      const other = await createPipeline(prisma, { organizationId: orgA.id });
      const a = await createDeal(prisma, owned(orgA, report), placement(pipelineA), {
        title: 'Alpha',
        amount: '300',
      });
      const b = await createDeal(prisma, owned(orgA, report), placement(other), {
        title: 'Beta_100%',
        amount: '100',
        status: 'WON',
      });
      const query = (params: object) => http().get(API).query(params).set(as(adminT)).expect(200);
      expect(ids(await query({ pipelineId: other.id }))).toEqual([b.id]);
      expect(ids(await query({ stageId: a.stageId }))).toEqual([a.id]);
      expect(ids(await query({ status: 'WON' }))).toEqual([b.id]);
      expect(ids(await query({ q: 'alp' }))).toEqual([a.id]);
      expect(ids(await query({ q: '_100%' }))).toEqual([b.id]); // wildcards are literal
      expect(ids(await query({ ownerId: repX.id }))).toEqual([]);
      const sorted = await query({ sortBy: 'amount', sortOrder: 'asc', limit: 1 });
      expect(sorted.body.data[0].id).toBe(b.id);
      expect(sorted.body.meta.total).toBe(2);
      await http().get(API).query({ sortBy: 'nonsense' }).set(as(adminT)).expect(400);
      await http().get(API).query({ status: 'NOPE' }).set(as(adminT)).expect(400);
    });
  });

  describe('update', () => {
    it('edits title, amount, currency and close date; null clears the date and the links', async () => {
      const contact = await createContact(prisma, owned(orgA, report));
      const company = await createCompany(prisma, owned(orgA, report));
      const deal = await createDeal(prisma, owned(orgA, report), placement(pipelineA), {
        contactId: contact.id,
        companyId: company.id,
      });
      const res = await patch(reportT, deal.id, {
        title: ' Renamed ',
        amount: '2000',
        currency: 'eur',
        expectedCloseDate: '2027-01-15',
      }).expect(200);
      expect(res.body).toMatchObject({
        title: 'Renamed',
        amount: '2000.00',
        currency: 'EUR',
        expectedCloseDate: '2027-01-15',
        contactId: contact.id,
      });
      const cleared = await patch(reportT, deal.id, {
        expectedCloseDate: null,
        contactId: null,
        companyId: null,
      }).expect(200);
      expect(cleared.body).toMatchObject({
        expectedCloseDate: null,
        contactId: null,
        companyId: null,
      });
    });

    it.each([
      ['an empty body', {}, 'EMPTY_UPDATE'],
      ['a stage', { stageId: MISSING_ID }, 'VALIDATION_FAILED'],
      ['a pipeline', { pipelineId: MISSING_ID }, 'VALIDATION_FAILED'],
      ['a status', { status: 'WON' }, 'VALIDATION_FAILED'],
      ['a null title', { title: null }, 'VALIDATION_FAILED'],
      ['a null amount', { amount: null }, 'VALIDATION_FAILED'],
      ['a null currency', { currency: null }, 'VALIDATION_FAILED'],
      ['a null owner', { ownerId: null }, 'VALIDATION_FAILED'],
      ['a JSON number amount', { amount: 5 }, 'VALIDATION_FAILED'],
      ['a negative amount', { amount: '-5' }, 'VALIDATION_FAILED'],
    ])('400 for %s', async (_label, body, code) => {
      const deal = await createDeal(prisma, owned(orgA, report), placement(pipelineA));
      expect((await patch(reportT, deal.id, body).expect(400)).body.code).toBe(code);
    });

    it('409 DEAL_CLOSED for a WON or LOST deal; nothing changes', async () => {
      for (const [status, index] of [
        ['WON', 4],
        ['LOST', 5],
      ] as const) {
        const deal = await createDeal(prisma, owned(orgA, report), placement(pipelineA, index), {
          status,
        });
        const res = await patch(reportT, deal.id, { title: 'Changed', amount: '9' }).expect(409);
        expect(res.body.code).toBe('DEAL_CLOSED');
        expect((await dealRow(deal.id)).title).not.toBe('Changed');
        await patch(adminT, deal.id, { ownerId: report.id }).expect(409);
      }
    });

    it('404 for a hidden deal even when it is closed (a closed deal is never revealed)', async () => {
      const closed = await createDeal(prisma, owned(orgA, repX), placement(pipelineA, 4), {
        status: 'WON',
      });
      await patch(reportT, closed.id, { title: 'x' }).expect(404);
      await patch(reportT, closed.id, { amount: '5' }).expect(404);
    });

    it('owner transfer: reps cannot, a manager within the team, an admin anywhere', async () => {
      const deal = await createDeal(prisma, owned(orgA, report), placement(pipelineA));
      expect((await patch(reportT, deal.id, { ownerId: repX.id }).expect(400)).body.code).toBe(
        'INVALID_OWNER',
      );
      await patch(managerT, deal.id, { ownerId: manager.id }).expect(200);
      await patch(adminT, deal.id, { ownerId: repX.id }).expect(200);
      expect((await dealRow(deal.id)).ownerId).toBe(repX.id);
      // Gone from the first owner's view after the transfer.
      await patch(reportT, deal.id, { title: 'x' }).expect(404);
    });

    it('re-links to a visible contact / company and refuses foreign, hidden and deleted ones', async () => {
      const deal = await createDeal(prisma, owned(orgA, report), placement(pipelineA));
      const contact = await createContact(prisma, owned(orgA, report));
      await patch(reportT, deal.id, { contactId: contact.id }).expect(200);
      const hidden = await createContact(prisma, owned(orgA, repX));
      const foreign = await createContact(prisma, owned(orgB, repB));
      const deleted = await createContact(prisma, owned(orgA, report), { deletedAt: new Date() });
      for (const contactId of [hidden.id, foreign.id, deleted.id, MISSING_ID]) {
        const res = await patch(reportT, deal.id, { contactId }).expect(400);
        expect(res.body.code).toBe('INVALID_CONTACT');
      }
      const company = await createCompany(prisma, owned(orgB, repB));
      expect((await patch(reportT, deal.id, { companyId: company.id }).expect(400)).body.code).toBe(
        'INVALID_COMPANY',
      );
      expect((await dealRow(deal.id)).contactId).toBe(contact.id);
    });

    it('an unchanged link is not re-checked, so a deal can still be edited after its contact moved to someone else', async () => {
      const contact = await createContact(prisma, owned(orgA, report));
      const deal = await createDeal(prisma, owned(orgA, report), placement(pipelineA), {
        contactId: contact.id,
      });
      await prisma.contact.update({ where: { id: contact.id }, data: { ownerId: repX.id } });
      await patch(reportT, deal.id, { contactId: contact.id, title: 'Still editable' }).expect(200);
    });

    it('404 for another organization; nothing changes', async () => {
      const foreignPipeline = await findDefaultPipeline(prisma, orgB.id);
      const foreign = await createDeal(prisma, owned(orgB, repB), placement(foreignPipeline), {
        title: 'Theirs',
      });
      await patch(adminT, foreign.id, { title: 'Mine now' }).expect(404);
      expect((await dealRow(foreign.id)).title).toBe('Theirs');
    });
  });

  describe('delete', () => {
    it('soft deletes a deal of any status; hidden and foreign deals are 404', async () => {
      const open = await createDeal(prisma, owned(orgA, report), placement(pipelineA));
      const won = await createDeal(prisma, owned(orgA, report), placement(pipelineA, 4), {
        status: 'WON',
      });
      await del(reportT, open.id).expect(204);
      await del(reportT, won.id).expect(204);
      expect((await dealRow(open.id)).deletedAt).not.toBeNull();
      await http().get(`${API}/${open.id}`).set(as(reportT)).expect(404);
      await del(reportT, open.id).expect(404);
      const hidden = await createDeal(prisma, owned(orgA, repX), placement(pipelineA));
      await del(reportT, hidden.id).expect(404);
      expect((await dealRow(hidden.id)).deletedAt).toBeNull();
    });
  });

  describe('contact and company delete blockers', () => {
    it('an OPEN deal blocks deleting its contact and company (409, no counts); a deleted or closed deal does not', async () => {
      const contact = await createContact(prisma, owned(orgA, report));
      const company = await createCompany(prisma, owned(orgA, report));
      const open = await createDeal(prisma, owned(orgA, repX), placement(pipelineA), {
        contactId: contact.id,
        companyId: company.id,
      });

      const contactBlocked = await http()
        .delete(`/api/v1/contacts/${contact.id}`)
        .set(as(reportT))
        .expect(409);
      expect(contactBlocked.body.code).toBe('CONTACT_HAS_OPEN_DEALS');
      expect(JSON.stringify(contactBlocked.body)).not.toMatch(/\d+ deal/);
      const companyBlocked = await http()
        .delete(`/api/v1/companies/${company.id}`)
        .set(as(reportT))
        .expect(409);
      expect(companyBlocked.body.code).toBe('COMPANY_HAS_DEALS');

      // Closed: no longer blocks.
      await prisma.deal.update({ where: { id: open.id }, data: { status: 'LOST' } });
      await http().delete(`/api/v1/contacts/${contact.id}`).set(as(reportT)).expect(204);
      await http().delete(`/api/v1/companies/${company.id}`).set(as(reportT)).expect(204);
    });

    it('a soft-deleted deal does not block', async () => {
      const contact = await createContact(prisma, owned(orgA, report));
      await createDeal(prisma, owned(orgA, report), placement(pipelineA), {
        contactId: contact.id,
        deletedAt: new Date(),
      });
      await http().delete(`/api/v1/contacts/${contact.id}`).set(as(reportT)).expect(204);
    });

    it('visibility comes first: a hidden contact / company is 404 even with open deals', async () => {
      const contact = await createContact(prisma, owned(orgA, repX));
      const company = await createCompany(prisma, owned(orgA, repX));
      await createDeal(prisma, owned(orgA, repX), placement(pipelineA), {
        contactId: contact.id,
        companyId: company.id,
      });
      await http().delete(`/api/v1/contacts/${contact.id}`).set(as(reportT)).expect(404);
      await http().delete(`/api/v1/companies/${company.id}`).set(as(reportT)).expect(404);
    });

    it('a deal of ANOTHER owner blocks too (the count is not visibility-scoped)', async () => {
      const contact = await createContact(prisma, owned(orgA, report));
      await createDeal(prisma, owned(orgA, repX), placement(pipelineA), { contactId: contact.id });
      await http().delete(`/api/v1/contacts/${contact.id}`).set(as(reportT)).expect(409);
    });
  });

  describe('records whose contact or company was deleted still read fine', () => {
    it('a closed deal whose contact and company were deleted later reads and lists without error', async () => {
      const contact = await createContact(prisma, owned(orgA, report));
      const company = await createCompany(prisma, owned(orgA, report));
      const deal = await createDeal(prisma, owned(orgA, report), placement(pipelineA, 4), {
        status: 'WON',
        contactId: contact.id,
        companyId: company.id,
      });
      await http().delete(`/api/v1/contacts/${contact.id}`).set(as(reportT)).expect(204);
      await http().delete(`/api/v1/companies/${company.id}`).set(as(reportT)).expect(204);

      const res = await http().get(`${API}/${deal.id}`).set(as(reportT)).expect(200);
      expect(res.body).toMatchObject({ contactId: contact.id, companyId: company.id });
      await http().get(API).set(as(reportT)).expect(200);
      await http().get(API).query({ contactId: contact.id }).set(as(reportT)).expect(200);
    });

    it('a contact referenced by a converted lead is deletable; the lead still reads fine (it keeps only the id)', async () => {
      const contact = await createContact(prisma, owned(orgA, report));
      const lead = await createLead(prisma, owned(orgA, report), { status: 'CONVERTED' });
      await prisma.lead.update({
        where: { id: lead.id },
        data: { convertedContactId: contact.id, convertedAt: new Date() },
      });
      await http().delete(`/api/v1/contacts/${contact.id}`).set(as(reportT)).expect(204);
      const res = await http().get(`/api/v1/leads/${lead.id}`).set(as(reportT)).expect(200);
      expect(res.body.convertedContactId).toBe(contact.id);
      await http().get('/api/v1/leads').set(as(reportT)).expect(200);
    });
  });

  // The invariants, whoever wins. The lock behaviour itself is pinned by the `locks` tests below.
  describe('races', () => {
    const openDealsOnDeletedContacts = () =>
      prisma.deal.count({
        where: { deletedAt: null, status: 'OPEN', contact: { deletedAt: { not: null } } },
      });
    const openDealsOnDeletedCompanies = () =>
      prisma.deal.count({
        where: { deletedAt: null, status: 'OPEN', company: { deletedAt: { not: null } } },
      });

    it('creating a deal for a contact vs. deleting the contact never leaves an open deal on a deleted contact', async () => {
      for (let i = 0; i < RACE_ITERATIONS; i += 1) {
        const contact = await createContact(prisma, owned(orgA, report));
        const [created, deleted] = await Promise.all([
          post(reportT, { title: `R${i}`, contactId: contact.id }),
          http().delete(`/api/v1/contacts/${contact.id}`).set(as(reportT)),
        ]);
        expect([201, 400]).toContain(created.status);
        expect([204, 409]).toContain(deleted.status);
        expect(await openDealsOnDeletedContacts()).toBe(0);
      }
    });

    it('creating a deal for a company vs. deleting the company never leaves an open deal on a deleted company', async () => {
      for (let i = 0; i < RACE_ITERATIONS; i += 1) {
        const company = await createCompany(prisma, owned(orgA, report));
        const [created, deleted] = await Promise.all([
          post(reportT, { title: `R${i}`, companyId: company.id }),
          http().delete(`/api/v1/companies/${company.id}`).set(as(reportT)),
        ]);
        expect([201, 400]).toContain(created.status);
        expect([204, 409]).toContain(deleted.status);
        expect(await openDealsOnDeletedCompanies()).toBe(0);
      }
    });

    it('PATCH contactId vs. deleting that contact never leaves an open deal on a deleted contact', async () => {
      for (let i = 0; i < RACE_ITERATIONS; i += 1) {
        const contact = await createContact(prisma, owned(orgA, report));
        const deal = await createDeal(prisma, owned(orgA, report), placement(pipelineA));
        const [linked, deleted] = await Promise.all([
          patch(reportT, deal.id, { contactId: contact.id }),
          http().delete(`/api/v1/contacts/${contact.id}`).set(as(reportT)),
        ]);
        expect([200, 400]).toContain(linked.status);
        expect([204, 409]).toContain(deleted.status);
        expect(await openDealsOnDeletedContacts()).toBe(0);
      }
    });

    it('PATCH companyId vs. deleting that company never leaves an open deal on a deleted company', async () => {
      for (let i = 0; i < RACE_ITERATIONS; i += 1) {
        const company = await createCompany(prisma, owned(orgA, report));
        const deal = await createDeal(prisma, owned(orgA, report), placement(pipelineA));
        const [linked, deleted] = await Promise.all([
          patch(reportT, deal.id, { companyId: company.id }),
          http().delete(`/api/v1/companies/${company.id}`).set(as(reportT)),
        ]);
        expect([200, 400]).toContain(linked.status);
        expect([204, 409]).toContain(deleted.status);
        expect(await openDealsOnDeletedCompanies()).toBe(0);
      }
    });

    it('creating a deal in a stage vs. deleting that stage: either 201 + STAGE_IN_USE or 400 + deleted, never a 500', async () => {
      for (let i = 0; i < RACE_ITERATIONS; i += 1) {
        const pipeline = await createPipeline(prisma, { organizationId: orgA.id });
        const stage = pipeline.stages[0];
        const [created, removed] = await Promise.all([
          post(reportT, { title: `R${i}`, pipelineId: pipeline.id, stageId: stage?.id }),
          http().delete(`/api/v1/pipelines/${pipeline.id}/stages/${stage?.id}`).set(as(adminT)),
        ]);
        expect([201, 400]).toContain(created.status);
        expect([204, 409]).toContain(removed.status);
        // Exactly one side wins.
        expect(created.status === 201).toBe(removed.status === 409);
      }
    });

    it('creating a deal in a pipeline vs. deleting the pipeline: exactly one wins, never a 500', async () => {
      for (let i = 0; i < RACE_ITERATIONS; i += 1) {
        const pipeline = await createPipeline(prisma, { organizationId: orgA.id });
        const [created, removed] = await Promise.all([
          post(reportT, { title: `R${i}`, pipelineId: pipeline.id }),
          http().delete(`/api/v1/pipelines/${pipeline.id}`).set(as(adminT)),
        ]);
        expect([201, 400]).toContain(created.status);
        expect([204, 409]).toContain(removed.status);
        expect(created.status === 201).toBe(removed.status === 409);
      }
    });

    it('parallel deal creations do not wait for each other (shared locks) and all succeed', async () => {
      const contact = await createContact(prisma, owned(orgA, report));
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          post(reportT, { title: `Parallel ${i}`, contactId: contact.id }),
        ),
      );
      expect(results.map((r) => r.status)).toEqual(Array(10).fill(201));
    });
  });

  // Deterministic proof of the locks and their modes. Each fails if the lock it names is removed.
  describe('locks', () => {
    it('a deal write waits for an EXCLUSIVE pipeline lock (a stage delete / reorder in flight)', async () => {
      const holder = await holdLock('pipeline', pipelineA.id);
      const pending = Promise.resolve(post(reportT, { title: 'x' }));
      expect(await stillPendingAfter(pending)).toBe(true);
      holder.release();
      await holder.done;
      expect((await pending).status).toBe(201);
    });

    it('deal writes proceed while only SHARED pipeline locks are held (they do not serialize)', async () => {
      const holder = await holdLock('pipeline', pipelineA.id, 'shared');
      const outcome = await Promise.race([
        Promise.resolve(post(reportT, { title: 'x' })).then((res) => res.status),
        new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 3000)),
      ]);
      expect(outcome).toBe(201);
      holder.release();
      await holder.done;
    });

    it('a deal for a contact waits for the contact lock, then sees a contact deleted meanwhile (INVALID_CONTACT)', async () => {
      const contact = await createContact(prisma, owned(orgA, report));
      const holder = await holdLock('contact', contact.id);
      const pending = Promise.resolve(post(reportT, { title: 'x', contactId: contact.id }));
      expect(await stillPendingAfter(pending)).toBe(true);
      await prisma.contact.update({ where: { id: contact.id }, data: { deletedAt: new Date() } });
      holder.release();
      await holder.done;
      const res = await pending;
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_CONTACT');
      expect(await dealCount()).toBe(0);
    });

    it('a deal for a company waits for the company lock', async () => {
      const company = await createCompany(prisma, owned(orgA, report));
      const holder = await holdLock('company', company.id);
      const pending = Promise.resolve(post(reportT, { title: 'x', companyId: company.id }));
      expect(await stillPendingAfter(pending)).toBe(true);
      holder.release();
      await holder.done;
      expect((await pending).status).toBe(201);
    });

    it('PATCH contactId and PATCH companyId wait for their locks', async () => {
      const contact = await createContact(prisma, owned(orgA, report));
      const company = await createCompany(prisma, owned(orgA, report));
      const deal = await createDeal(prisma, owned(orgA, report), placement(pipelineA));
      const contactHolder = await holdLock('contact', contact.id);
      const relink = Promise.resolve(patch(reportT, deal.id, { contactId: contact.id }));
      expect(await stillPendingAfter(relink)).toBe(true);
      contactHolder.release();
      await contactHolder.done;
      expect((await relink).status).toBe(200);

      const companyHolder = await holdLock('company', company.id);
      const relinkCompany = Promise.resolve(patch(reportT, deal.id, { companyId: company.id }));
      expect(await stillPendingAfter(relinkCompany)).toBe(true);
      companyHolder.release();
      await companyHolder.done;
      expect((await relinkCompany).status).toBe(200);
    });

    it.each([
      ['contact', 'contacts'],
      ['company', 'companies'],
    ] as const)(
      'deleting a %s waits while a deal write holds its lock SHARED',
      async (kind, path) => {
        const record =
          kind === 'contact'
            ? await createContact(prisma, owned(orgA, report))
            : await createCompany(prisma, owned(orgA, report));
        const holder = await holdLock(kind, record.id, 'shared');
        const pending = Promise.resolve(
          http().delete(`/api/v1/${path}/${record.id}`).set(as(reportT)),
        );
        expect(await stillPendingAfter(pending)).toBe(true);
        holder.release();
        await holder.done;
        expect((await pending).status).toBe(204);
      },
    );
  });
});
