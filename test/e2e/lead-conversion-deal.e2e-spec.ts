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
  createCompany,
  createContact,
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

const API = '/api/v1/leads';
const RACE_ITERATIONS = 20;
const MISSING_ID = '11111111-1111-4111-8111-111111111111';
const SENTINEL_SCORE = 73;

interface Tokens {
  accessToken: string;
}

describe('Lead conversion with a deal (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let events: EventEmitter2;
  let orgA: TestOrganization;
  let orgB: TestOrganization;
  let manager: TestUser;
  let report: TestUser;
  let repX: TestUser;
  let noDeals: TestUser; // leads:convert + contacts:create + companies:create, no deals:create
  let linkOnly: TestUser; // leads:convert + deals:create
  let repB: TestUser;
  let adminT: Tokens;
  let managerT: Tokens;
  let reportT: Tokens;
  let noDealsT: Tokens;
  let linkOnlyT: Tokens;
  let repBT: Tokens;
  let pipelineA: Awaited<ReturnType<typeof findDefaultPipeline>>;

  const http = () => request(app.getHttpServer());
  const signIn = async ({ email, password }: Pick<TestUser, 'email' | 'password'>) =>
    (await http().post('/api/v1/auth/login').send({ email, password }).expect(200)).body as Tokens;
  const as = (tokens: Tokens) => ({ Authorization: `Bearer ${tokens.accessToken}` });
  const owned = (org: TestOrganization, user: Pick<TestUser, 'id'>) => ({
    organizationId: org.id,
    ownerId: user.id,
  });
  const convert = (tokens: Tokens, id: string, body: object = {}) =>
    http().post(`${API}/${id}/convert`).set(as(tokens)).send(body);
  const qualified = (user: Pick<TestUser, 'id'>) =>
    createLead(prisma, owned(orgA, user), {
      status: 'QUALIFIED',
      score: SENTINEL_SCORE,
      email: 'omar@globex.com',
      companyName: 'Globex',
    });
  const leadRow = (id: string) => prisma.lead.findUniqueOrThrow({ where: { id } });
  const counts = async () => ({
    contacts: await prisma.contact.count(),
    companies: await prisma.company.count(),
    deals: await prisma.deal.count(),
    history: await prisma.dealStageHistory.count(),
  });

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
    await prisma.organization.update({ where: { id: orgA.id }, data: { defaultCurrency: 'EGP' } });
    manager = await createUser(prisma, orgA, { role: ROLE_NAMES.SALES_MANAGER });
    report = await createUser(prisma, orgA, { managerId: manager.id });
    repX = await createUser(prisma, orgA);
    const withoutDeals = await createCustomRole(prisma, orgA, 'No deals', [
      'leads:convert',
      'contacts:create',
      'companies:create',
    ]);
    noDeals = await createUser(prisma, orgA, { role: withoutDeals.name });
    const linking = await createCustomRole(prisma, orgA, 'Link and deal', [
      'leads:convert',
      'deals:create',
    ]);
    linkOnly = await createUser(prisma, orgA, { role: linking.name });
    repB = await createUser(prisma, orgB);
    [adminT, managerT, reportT, noDealsT, linkOnlyT, repBT] = await Promise.all(
      [orgA.admin, manager, report, noDeals, linkOnly, repB].map(signIn),
    );
    pipelineA = await findDefaultPipeline(prisma, orgA.id);
  });

  afterEach(() => {
    events.removeAllListeners('lead.converted');
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('happy paths', () => {
    it('creates contact, company and deal in one go: linked, owned by the lead owner, in the first open stage, with its first history row; the score is untouched', async () => {
      const lead = await qualified(report);
      const res = await convert(managerT, lead.id, {
        createCompany: true,
        deal: { title: '  Globex licence ', amount: '12500.5' },
      }).expect(200);

      expect(Object.keys(res.body).sort()).toEqual(['contact', 'createdCompany', 'deal', 'lead']);
      expect(res.body.deal).toMatchObject({
        title: 'Globex licence',
        amount: '12500.50',
        currency: 'EGP',
        status: 'OPEN',
        pipelineId: pipelineA.id,
        stageId: pipelineA.stages[0]?.id,
        contactId: res.body.contact.id,
        companyId: res.body.createdCompany.id,
        ownerId: report.id,
      });
      expect(res.body.lead).toMatchObject({
        status: 'CONVERTED',
        score: SENTINEL_SCORE,
        convertedContactId: res.body.contact.id,
        convertedDealId: res.body.deal.id,
      });

      const row = await leadRow(lead.id);
      expect(row.convertedDealId).toBe(res.body.deal.id);
      const history = await prisma.dealStageHistory.findMany({
        where: { dealId: res.body.deal.id },
      });
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        fromStageId: null,
        toStageId: pipelineA.stages[0]?.id,
        changedById: manager.id, // the person who clicked convert
      });
    });

    it('takes explicit pipeline, stage, currency and close date', async () => {
      const other = await createPipeline(prisma, { organizationId: orgA.id });
      const lead = await qualified(report);
      const res = await convert(reportT, lead.id, {
        deal: {
          title: 'Explicit',
          amount: '10',
          currency: 'eur',
          pipelineId: other.id,
          stageId: other.stages[1]?.id,
          expectedCloseDate: '2027-03-01',
        },
      }).expect(200);
      expect(res.body.deal).toMatchObject({
        currency: 'EUR',
        pipelineId: other.id,
        stageId: other.stages[1]?.id,
        expectedCloseDate: '2027-03-01',
        companyId: null,
      });
    });

    it('with an existing contact: the contact is untouched and the deal takes the company that contact has', async () => {
      const company = await createCompany(prisma, owned(orgA, report));
      const contact = await createContact(prisma, owned(orgA, report), { companyId: company.id });
      const before = await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } });
      const lead = await qualified(report);
      const res = await convert(reportT, lead.id, {
        contactId: contact.id,
        deal: { title: 'Upsell' },
      }).expect(200);
      expect(res.body.deal).toMatchObject({
        contactId: contact.id,
        companyId: company.id,
        amount: '0.00',
      });
      expect(await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } })).toEqual(before);
    });

    it('the lead, the deal and its history read back through their own endpoints', async () => {
      const lead = await qualified(report);
      const res = await convert(reportT, lead.id, { deal: { title: 'Readable' } }).expect(200);
      const readLead = await http().get(`${API}/${lead.id}`).set(as(reportT)).expect(200);
      expect(readLead.body.convertedDealId).toBe(res.body.deal.id);
      await http().get(`/api/v1/deals/${res.body.deal.id}`).set(as(reportT)).expect(200);
      const history = await http()
        .get(`/api/v1/deals/${res.body.deal.id}/history`)
        .set(as(reportT))
        .expect(200);
      expect(history.body.meta.total).toBe(1);
    });

    it('the deal keeps its contact and company from being deleted while it is open', async () => {
      const lead = await qualified(report);
      const res = await convert(reportT, lead.id, {
        createCompany: true,
        deal: { title: 'Pinned' },
      }).expect(200);
      const contact = await http()
        .delete(`/api/v1/contacts/${res.body.contact.id}`)
        .set(as(reportT))
        .expect(409);
      expect(contact.body.code).toBe('CONTACT_HAS_OPEN_DEALS');
    });

    it('lead.converted carries the dealId (ids only)', async () => {
      const received: Record<string, unknown>[] = [];
      events.on('lead.converted', (payload: Record<string, unknown>) => {
        received.push(payload);
      });
      const lead = await qualified(report);
      const res = await convert(reportT, lead.id, { deal: { title: 'Confidential title' } }).expect(
        200,
      );
      await vi.waitFor(() => expect(received).toHaveLength(1));
      expect(received[0]).toMatchObject({
        leadId: lead.id,
        contactId: res.body.contact.id,
        dealId: res.body.deal.id,
      });
      expect(JSON.stringify(received[0])).not.toMatch(/Confidential/);
    });

    it('without a deal the response says deal: null and no deal exists', async () => {
      const lead = await qualified(report);
      const res = await convert(reportT, lead.id).expect(200);
      expect(res.body.deal).toBeNull();
      expect(res.body.lead.convertedDealId).toBeNull();
      expect((await counts()).deals).toBe(0);
    });
  });

  describe('permissions', () => {
    it('403 without deals:create when a deal is requested; nothing changes', async () => {
      const lead = await qualified(noDeals);
      const res = await convert(noDealsT, lead.id, { deal: { title: 'x' } }).expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
      expect((await leadRow(lead.id)).status).toBe('QUALIFIED');
      expect(await counts()).toEqual({ contacts: 0, companies: 0, deals: 0, history: 0 });
    });

    it('the same user converts without a deal (deals:create is needed only for the deal)', async () => {
      const lead = await qualified(noDeals);
      await convert(noDealsT, lead.id).expect(200);
    });

    it('linking an existing contact with a deal needs only leads:convert and deals:create', async () => {
      const lead = await qualified(linkOnly);
      const contact = await createContact(prisma, owned(orgA, linkOnly));
      const res = await convert(linkOnlyT, lead.id, {
        contactId: contact.id,
        deal: { title: 'Linked' },
      }).expect(200);
      expect(res.body.deal.contactId).toBe(contact.id);
      // ... but creating a contact still needs contacts:create.
      const second = await qualified(linkOnly);
      await convert(linkOnlyT, second.id, { deal: { title: 'x' } }).expect(403);
    });
  });

  describe('validation and rollback', () => {
    it.each([
      ['a JSON number amount', { title: 'x', amount: 500 }],
      ['a negative amount', { title: 'x', amount: '-1' }],
      ['an exponent amount', { title: 'x', amount: '1e3' }],
      ['a missing title', { amount: '5' }],
      ['a blank title', { title: '  ' }],
      ['an unknown currency', { title: 'x', currency: 'XXY' }],
      ['a bad date', { title: 'x', expectedCloseDate: '2026-02-31' }],
      ['a contact link', { title: 'x', contactId: MISSING_ID }],
      ['an owner', { title: 'x', ownerId: MISSING_ID }],
      ['a status', { title: 'x', status: 'WON' }],
    ])('400 for %s; nothing changes', async (_label, deal) => {
      const lead = await qualified(report);
      const res = await convert(reportT, lead.id, { deal }).expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect((await leadRow(lead.id)).status).toBe('QUALIFIED');
      expect(await counts()).toEqual({ contacts: 0, companies: 0, deals: 0, history: 0 });
    });

    it('400 for a null or non-object deal', async () => {
      const lead = await qualified(report);
      await convert(reportT, lead.id, { deal: null }).expect(400);
      await convert(reportT, lead.id, { deal: 'x' }).expect(400);
    });

    it('an invalid stage or pipeline rolls EVERYTHING back: no contact, company, deal, history; the lead stays QUALIFIED', async () => {
      const other = await createPipeline(prisma, { organizationId: orgA.id });
      const foreign = await findDefaultPipeline(prisma, orgB.id);
      const cases: [object, string][] = [
        [{ title: 'x', stageId: pipelineA.stages[4]?.id }, 'INVALID_STAGE'], // Won
        [{ title: 'x', stageId: pipelineA.stages[5]?.id }, 'INVALID_STAGE'], // Lost
        [{ title: 'x', stageId: other.stages[0]?.id }, 'INVALID_STAGE'], // another pipeline
        [{ title: 'x', stageId: foreign.stages[0]?.id }, 'INVALID_STAGE'], // another organization
        [{ title: 'x', pipelineId: foreign.id }, 'INVALID_PIPELINE'],
        [{ title: 'x', pipelineId: MISSING_ID }, 'INVALID_PIPELINE'],
      ];
      for (const [deal, code] of cases) {
        const lead = await qualified(report);
        const res = await convert(reportT, lead.id, { createCompany: true, deal }).expect(400);
        expect(res.body.code).toBe(code);
        const row = await leadRow(lead.id);
        expect([row.status, row.convertedAt, row.convertedContactId, row.convertedDealId]).toEqual([
          'QUALIFIED',
          null,
          null,
          null,
        ]);
        expect(await counts()).toEqual({ contacts: 0, companies: 0, deals: 0, history: 0 });
      }
    });

    it('404 for a lead the caller cannot see, and nothing is created', async () => {
      const lead = await qualified(report);
      await convert(repBT, lead.id, { deal: { title: 'x' } }).expect(404);
      expect(await counts()).toEqual({ contacts: 0, companies: 0, deals: 0, history: 0 });
    });

    it('converting twice with a deal: the second is 409 and only one deal exists', async () => {
      const lead = await qualified(report);
      await convert(reportT, lead.id, { deal: { title: 'once' } }).expect(200);
      const again = await convert(reportT, lead.id, { deal: { title: 'twice' } }).expect(409);
      expect(again.body.code).toBe('LEAD_ALREADY_CONVERTED');
      expect((await counts()).deals).toBe(1);
    });

    it('a repeated pipeline-less default is resolved per request: no default pipeline at all is a 400', async () => {
      const lead = await qualified(report);
      await prisma.pipeline.update({ where: { id: pipelineA.id }, data: { isDefault: false } });
      const res = await convert(reportT, lead.id, { deal: { title: 'x' } }).expect(400);
      expect(res.body.code).toBe('INVALID_PIPELINE');
      expect((await leadRow(lead.id)).status).toBe('QUALIFIED');
    });
  });

  describe('races', () => {
    it('parallel conversions with a deal: exactly one wins and exactly one deal exists', async () => {
      for (let i = 0; i < RACE_ITERATIONS; i += 1) {
        const before = (await counts()).deals;
        const lead = await qualified(report);
        const results = await Promise.all([
          convert(reportT, lead.id, { deal: { title: `A${i}` } }),
          convert(managerT, lead.id, { deal: { title: `B${i}` } }),
          convert(adminT, lead.id, { deal: { title: `C${i}` } }),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
        expect((await counts()).deals).toBe(before + 1);
        const winner = results.find((r) => r.status === 200);
        expect((await leadRow(lead.id)).convertedDealId).toBe(winner?.body.deal.id);
      }
    });

    it('conversion with a deal in a stage vs. deleting that stage: exactly one wins, never a 500, nothing half-done', async () => {
      for (let i = 0; i < RACE_ITERATIONS; i += 1) {
        const pipeline = await createPipeline(prisma, { organizationId: orgA.id });
        const stage = pipeline.stages[0];
        const lead = await qualified(report);
        const [converted, removed] = await Promise.all([
          convert(reportT, lead.id, {
            deal: { title: `R${i}`, pipelineId: pipeline.id, stageId: stage?.id },
          }),
          http().delete(`/api/v1/pipelines/${pipeline.id}/stages/${stage?.id}`).set(as(adminT)),
        ]);
        expect([200, 400]).toContain(converted.status);
        expect([204, 409]).toContain(removed.status);
        expect(converted.status === 200).toBe(removed.status === 409);
        const row = await leadRow(lead.id);
        expect(row.status).toBe(converted.status === 200 ? 'CONVERTED' : 'QUALIFIED');
        expect(row.convertedDealId === null).toBe(converted.status !== 200);
      }
    });

    it('conversion with a deal in a pipeline vs. deleting the pipeline: exactly one wins, never a 500', async () => {
      for (let i = 0; i < RACE_ITERATIONS; i += 1) {
        const pipeline = await createPipeline(prisma, { organizationId: orgA.id });
        const lead = await qualified(report);
        const [converted, removed] = await Promise.all([
          convert(reportT, lead.id, { deal: { title: `R${i}`, pipelineId: pipeline.id } }),
          http().delete(`/api/v1/pipelines/${pipeline.id}`).set(as(adminT)),
        ]);
        expect([200, 400]).toContain(converted.status);
        expect([204, 409]).toContain(removed.status);
        expect(converted.status === 200).toBe(removed.status === 409);
      }
    });

    it('conversion with a deal and a company link vs. deleting the company: never an open deal on a deleted company', async () => {
      for (let i = 0; i < RACE_ITERATIONS; i += 1) {
        const company = await createCompany(prisma, owned(orgA, report));
        const lead = await qualified(report);
        const [converted, removed] = await Promise.all([
          convert(reportT, lead.id, { companyId: company.id, deal: { title: `R${i}` } }),
          http().delete(`/api/v1/companies/${company.id}`).set(as(reportT)),
        ]);
        expect([200, 400]).toContain(converted.status);
        expect([204, 409]).toContain(removed.status);
        expect(
          await prisma.deal.count({
            where: { deletedAt: null, status: 'OPEN', company: { deletedAt: { not: null } } },
          }),
        ).toBe(0);
      }
    });
  });

  describe('locks', () => {
    it('a conversion WITH a deal waits for an exclusive pipeline lock, and nothing is written meanwhile', async () => {
      const lead = await qualified(report);
      const holder = await holdLock('pipeline', pipelineA.id);
      const pending = Promise.resolve(convert(reportT, lead.id, { deal: { title: 'x' } }));
      expect(await stillPendingAfter(pending)).toBe(true);
      expect((await leadRow(lead.id)).status).toBe('QUALIFIED');
      holder.release();
      await holder.done;
      expect((await pending).status).toBe(200);
    });

    it('a conversion WITHOUT a deal ignores the pipeline lock', async () => {
      const lead = await qualified(report);
      const holder = await holdLock('pipeline', pipelineA.id);
      const outcome = await Promise.race([
        Promise.resolve(convert(reportT, lead.id)).then((res) => res.status),
        new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 3000)),
      ]);
      expect(outcome).toBe(200);
      holder.release();
      await holder.done;
    });

    it('conversions with a deal proceed while only shared pipeline locks are held (they do not serialize)', async () => {
      const holder = await holdLock('pipeline', pipelineA.id, 'shared');
      const leads = await Promise.all([qualified(report), qualified(report), qualified(report)]);
      const outcome = await Promise.race([
        Promise.all(leads.map((lead) => convert(reportT, lead.id, { deal: { title: 'x' } }))).then(
          (all) => all.map((r) => r.status),
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 5000)),
      ]);
      expect(outcome).toEqual([200, 200, 200]);
      holder.release();
      await holder.done;
    });
  });

  it('a repX lead is untouched by a manager outside the team', async () => {
    const lead = await qualified(repX);
    await convert(managerT, lead.id, { deal: { title: 'x' } }).expect(404);
    expect(await counts()).toEqual({ contacts: 0, companies: 0, deals: 0, history: 0 });
  });
});
