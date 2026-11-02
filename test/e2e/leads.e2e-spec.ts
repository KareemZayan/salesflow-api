import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '../../prisma/seed/prisma-client';
import { ROLE_NAMES } from '../../prisma/seed/permissions';
import { acquireLock } from '../../src/infrastructure/prisma/advisory-lock';
import { createCompany, createLead } from '../factories/crm.factory';
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

interface Tokens {
  accessToken: string;
}

describe('Leads (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let orgA: TestOrganization;
  let orgB: TestOrganization;
  let manager: TestUser;
  let report: TestUser;
  let inactiveReport: TestUser;
  let repX: TestUser; // a rep outside the manager's team
  let nobody: TestUser; // authenticated, holds no permission
  let repB: TestUser;

  let adminT: Tokens;
  let managerT: Tokens;
  let reportT: Tokens;
  let repXT: Tokens;
  let repBT: Tokens;

  const http = () => request(app.getHttpServer());
  const signIn = async ({ email, password }: Pick<TestUser, 'email' | 'password'>) =>
    (await http().post('/api/v1/auth/login').send({ email, password }).expect(200)).body as Tokens;
  const as = (tokens: Tokens) => ({ Authorization: `Bearer ${tokens.accessToken}` });
  const owned = (org: TestOrganization, user: Pick<TestUser, 'id'>) => ({
    organizationId: org.id,
    ownerId: user.id,
  });
  const row = (id: string) => prisma.lead.findUniqueOrThrow({ where: { id } });
  const ids = (res: request.Response): string[] =>
    (res.body.data as { id: string }[]).map(({ id }) => id).sort();
  const base = { firstName: 'Omar', lastName: 'Khaled', source: 'OTHER' };
  const post = (tokens: Tokens, body: object) => http().post(API).set(as(tokens)).send(body);
  const patch = (tokens: Tokens, id: string, body: object) =>
    http().patch(`${API}/${id}`).set(as(tokens)).send(body);

  beforeAll(async () => {
    app = await createTestApp();
    prisma = createTestPrisma();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    orgA = await createOrganization(prisma, 'orga');
    orgB = await createOrganization(prisma, 'orgb');
    manager = await createUser(prisma, orgA, { role: ROLE_NAMES.SALES_MANAGER });
    report = await createUser(prisma, orgA, { managerId: manager.id });
    inactiveReport = await createUser(prisma, orgA, { managerId: manager.id, isActive: false });
    repX = await createUser(prisma, orgA);
    const noPermissions = await createCustomRole(prisma, orgA, 'Nobody', []);
    nobody = await createUser(prisma, orgA, { role: noPermissions.name });
    repB = await createUser(prisma, orgB);
    [adminT, managerT, reportT, repXT, repBT] = await Promise.all(
      [orgA.admin, manager, report, repX, repB].map(signIn),
    );
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('authentication and permissions', () => {
    it('401 without a token, on every route', async () => {
      const lead = await createLead(prisma, owned(orgA, report));
      await http().get(API).expect(401);
      await http().get(`${API}/${lead.id}`).expect(401);
      await http().post(API).send(base).expect(401);
      await http().patch(`${API}/${lead.id}`).send({ notes: 'x' }).expect(401);
      await http().delete(`${API}/${lead.id}`).expect(401);
    });

    it('403 FORBIDDEN without the matching permission, on every route', async () => {
      const t = await signIn(nobody);
      const lead = await createLead(prisma, owned(orgA, nobody));
      for (const res of [
        await http().get(API).set(as(t)),
        await http().get(`${API}/${lead.id}`).set(as(t)),
        await http().post(API).set(as(t)).send(base),
        await http().patch(`${API}/${lead.id}`).set(as(t)).send({ notes: 'x' }),
        await http().delete(`${API}/${lead.id}`).set(as(t)),
      ]) {
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('FORBIDDEN');
      }
    });
  });

  describe('create', () => {
    it('201: owner defaults to the caller, status NEW, text trimmed, email lowercased, exact shape', async () => {
      const res = await post(reportT, {
        firstName: '  Omar ',
        lastName: ' Khaled  ',
        source: 'WEBSITE',
        email: ' Omar@GLOBEX.com ',
        phone: '+20 100 123 4567',
        companyName: '  Globex ',
        notes: ' met at the expo ',
      }).expect(201);
      expect(res.body).toMatchObject({
        firstName: 'Omar',
        lastName: 'Khaled',
        source: 'WEBSITE',
        email: 'omar@globex.com',
        phone: '+20 100 123 4567',
        companyName: 'Globex',
        notes: 'met at the expo',
        status: 'NEW',
        ownerId: report.id,
        convertedAt: null,
        convertedContactId: null,
        convertedDealId: null,
      });
      expect(Object.keys(res.body).sort()).toEqual(
        [
          'companyName',
          'convertedAt',
          'convertedContactId',
          'convertedDealId',
          'createdAt',
          'email',
          'firstName',
          'id',
          'lastName',
          'notes',
          'ownerId',
          'phone',
          'score',
          'source',
          'status',
          'updatedAt',
        ].sort(),
      );
      expect((await row(res.body.id)).organizationId).toBe(orgA.id);
    });

    it('the server computes the score: source weight + email 20 + phone 15 + company 10', async () => {
      const bare = await post(reportT, { ...base, source: 'REFERRAL' }).expect(201);
      expect(bare.body.score).toBe(40);
      const full = await post(reportT, {
        ...base,
        source: 'REFERRAL',
        email: 'a@b.co',
        phone: '12345',
        companyName: 'Acme',
      }).expect(201);
      expect(full.body.score).toBe(85);
      expect((await row(full.body.id)).score).toBe(85);
    });

    it('blank email, phone and company name are stored as NULL and earn no points', async () => {
      const res = await post(reportT, {
        ...base,
        email: '  ',
        phone: '',
        companyName: '   ',
      }).expect(201);
      expect(res.body).toMatchObject({ email: null, phone: null, companyName: null, score: 0 });
    });

    it('allows duplicate emails (the ERD has no uniqueness)', async () => {
      const body = { ...base, email: 'twin@acme.com' };
      await post(reportT, body).expect(201);
      await post(reportT, body).expect(201);
    });

    it('400 VALIDATION_FAILED on bad input', async () => {
      const bad: object[] = [
        {},
        { firstName: 'A', lastName: 'B' }, // source is required
        { ...base, firstName: '   ' },
        { ...base, lastName: 'x'.repeat(101) },
        { ...base, source: 'TELEPATHY' },
        { ...base, source: null },
        { ...base, email: 'not-an-email' },
        { ...base, phone: 'call me' },
        { ...base, companyName: 'x'.repeat(201) },
        { ...base, notes: 'x'.repeat(5001) },
        { ...base, ownerId: 'not-a-uuid' },
        { ...base, firstName: 5 },
      ];
      for (const body of bad) {
        const res = await post(reportT, body).expect(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
      expect(await prisma.lead.count()).toBe(0);
    });

    it('400 for server-owned fields in the body: score, status, conversion, tenant, ids, dates', async () => {
      for (const extra of [
        { score: 100 },
        { status: 'QUALIFIED' },
        { status: 'CONVERTED' },
        { convertedAt: '2020-01-01T00:00:00.000Z' },
        { convertedContactId: MISSING_ID },
        { convertedDealId: MISSING_ID },
        { organizationId: orgB.id },
        { deletedAt: null },
        { createdAt: '2020-01-01T00:00:00.000Z' },
        { id: MISSING_ID },
      ]) {
        const res = await post(reportT, { ...base, ...extra }).expect(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
      expect(await prisma.lead.count()).toBe(0);
    });

    describe('owner assignment', () => {
      const create = (tokens: Tokens, ownerId: string) => post(tokens, { ...base, ownerId });

      it('a rep may name only themselves', async () => {
        await create(reportT, report.id).expect(201);
        for (const target of [repX.id, manager.id, orgA.admin.id]) {
          expect((await create(reportT, target).expect(400)).body.code).toBe('INVALID_OWNER');
        }
        expect(await prisma.lead.count()).toBe(1);
      });

      it('a manager may name themselves or an ACTIVE report, nobody else', async () => {
        expect((await create(managerT, report.id).expect(201)).body.ownerId).toBe(report.id);
        for (const target of [inactiveReport.id, repX.id, orgA.admin.id, repB.id]) {
          expect((await create(managerT, target).expect(400)).body.code).toBe('INVALID_OWNER');
        }
      });

      it('an admin may name any ACTIVE user of the organization, not other organizations', async () => {
        await create(adminT, repX.id).expect(201);
        for (const target of [inactiveReport.id, repB.id]) {
          expect((await create(adminT, target).expect(400)).body.code).toBe('INVALID_OWNER');
        }
      });

      it('there is no way to create an ownerless lead: null is rejected, omitting means the caller', async () => {
        expect((await post(reportT, { ...base, ownerId: null }).expect(201)).body.ownerId).toBe(
          report.id,
        );
      });
    });
  });

  describe('list', () => {
    it('shows each role only what it may see (own / team / organization)', async () => {
      const mine = await createLead(prisma, owned(orgA, report));
      const managers = await createLead(prisma, owned(orgA, manager));
      const inactives = await createLead(prisma, owned(orgA, inactiveReport));
      const others = await createLead(prisma, owned(orgA, repX));
      await createLead(prisma, owned(orgB, repB));
      await createLead(prisma, owned(orgA, report), { deletedAt: new Date() });

      const get = async (tokens: Tokens) => ids(await http().get(API).set(as(tokens)).expect(200));
      expect(await get(reportT)).toEqual([mine.id]);
      expect(await get(managerT)).toEqual([mine.id, managers.id, inactives.id].sort());
      expect(await get(adminT)).toEqual([mine.id, managers.id, inactives.id, others.id].sort());
    });

    it('the total counts only visible rows; pagination is stable', async () => {
      for (let i = 0; i < 3; i += 1) await createLead(prisma, owned(orgA, report));
      await createLead(prisma, owned(orgA, repX));
      const res = await http().get(`${API}?limit=2&page=2`).set(as(reportT)).expect(200);
      expect(res.body.meta).toEqual({ page: 2, limit: 2, total: 3, totalPages: 2 });
      expect(res.body.data).toHaveLength(1);
    });

    it('?ownerId narrows but never widens', async () => {
      const mine = await createLead(prisma, owned(orgA, report));
      await createLead(prisma, owned(orgA, repX));
      const own = await http().get(`${API}?ownerId=${report.id}`).set(as(reportT)).expect(200);
      expect(ids(own)).toEqual([mine.id]);
      const other = await http().get(`${API}?ownerId=${repX.id}`).set(as(reportT)).expect(200);
      expect(other.body.data).toEqual([]);
      expect(other.body.meta.total).toBe(0);
    });

    it('?status and ?source filter; an unknown value is 400', async () => {
      const web = await createLead(prisma, owned(orgA, report), { source: 'WEBSITE' });
      const ref = await createLead(prisma, owned(orgA, report), { source: 'REFERRAL' });
      await prisma.lead.update({ where: { id: ref.id }, data: { status: 'CONTACTED' } });
      const get = async (query: string) =>
        ids(await http().get(`${API}?${query}`).set(as(reportT)).expect(200));
      expect(await get('source=WEBSITE')).toEqual([web.id]);
      expect(await get('status=CONTACTED')).toEqual([ref.id]);
      expect(await get('status=NEW&source=REFERRAL')).toEqual([]);
      await http().get(`${API}?status=NOPE`).set(as(reportT)).expect(400);
      await http().get(`${API}?source=NOPE`).set(as(reportT)).expect(400);
    });

    it('?q searches name, email and company case-insensitively; % and _ are literal', async () => {
      const omar = await createLead(prisma, owned(orgA, report), { firstName: 'Omar' });
      const mail = await createLead(prisma, owned(orgA, report), { email: 'x@findme.io' });
      const company = await createLead(prisma, owned(orgA, report), { companyName: 'Globex 50%' });
      const search = async (q: string) =>
        ids(await http().get(API).query({ q }).set(as(reportT)).expect(200));
      expect(await search('OMAR')).toEqual([omar.id]);
      expect(await search('FINDME')).toEqual([mail.id]);
      expect(await search('globex')).toEqual([company.id]);
      expect(await search('%')).toEqual([company.id]);
      expect(await search('_')).toEqual([]);
    });

    it('sorts by score; 400 INVALID_SORT_FIELD outside the whitelist', async () => {
      const low = await createLead(prisma, owned(orgA, report), { score: 5 });
      const high = await createLead(prisma, owned(orgA, report), { score: 90 });
      const res = await http()
        .get(`${API}?sortBy=score&sortOrder=desc`)
        .set(as(reportT))
        .expect(200);
      expect((res.body.data as { id: string }[]).map(({ id }) => id)).toEqual([high.id, low.id]);
      const bad = await http().get(`${API}?sortBy=email`).set(as(reportT)).expect(400);
      expect(bad.body.code).toBe('INVALID_SORT_FIELD');
    });
  });

  describe('get', () => {
    it('200 for a visible lead; no tenant or soft-delete columns leak', async () => {
      const lead = await createLead(prisma, owned(orgA, report));
      const res = await http().get(`${API}/${lead.id}`).set(as(reportT)).expect(200);
      expect(res.body.id).toBe(lead.id);
      expect(res.body).not.toHaveProperty('organizationId');
      expect(res.body).not.toHaveProperty('deletedAt');
    });

    it('404 for missing, deleted, not-visible and other-organization leads; 400 for a bad id', async () => {
      const theirs = await createLead(prisma, owned(orgA, repX));
      const deleted = await createLead(prisma, owned(orgA, report), { deletedAt: new Date() });
      const foreign = await createLead(prisma, owned(orgB, repB));
      for (const id of [MISSING_ID, theirs.id, deleted.id, foreign.id]) {
        const res = await http().get(`${API}/${id}`).set(as(reportT)).expect(404);
        expect(res.body.code).toBe('RESOURCE_NOT_FOUND');
      }
      await http().get(`${API}/nope`).set(as(reportT)).expect(400);
    });

    it('a manager reads a report lead; a rep outside the team does not', async () => {
      const lead = await createLead(prisma, owned(orgA, report));
      await http().get(`${API}/${lead.id}`).set(as(managerT)).expect(200);
      await http().get(`${API}/${lead.id}`).set(as(repXT)).expect(404);
    });

    it('a lead whose company name matches a soft-deleted company still reads fine', async () => {
      // `companyName` is free text, not a foreign key: deleting a Company can never break a lead.
      const company = await createCompany(prisma, owned(orgA, report), { name: 'Globex' });
      const lead = await createLead(prisma, owned(orgA, report), { companyName: 'Globex' });
      await prisma.company.update({ where: { id: company.id }, data: { deletedAt: new Date() } });
      const res = await http().get(`${API}/${lead.id}`).set(as(reportT)).expect(200);
      expect(res.body.companyName).toBe('Globex');
      await http().get(API).set(as(reportT)).expect(200);
    });
  });

  describe('update', () => {
    it('edits fields and clears optional ones with null or a blank string', async () => {
      const lead = await createLead(prisma, owned(orgA, report), {
        email: 'a@b.co',
        phone: '12345',
        companyName: 'Acme',
        notes: 'old',
      });
      const res = await patch(reportT, lead.id, {
        firstName: ' Nora ',
        email: null,
        phone: '  ',
        companyName: null,
        notes: '',
      }).expect(200);
      expect(res.body).toMatchObject({
        firstName: 'Nora',
        email: null,
        phone: null,
        companyName: null,
        notes: null,
      });
    });

    it('400 EMPTY_UPDATE for an empty body; 400 for null on NOT NULL fields and unknown fields', async () => {
      const lead = await createLead(prisma, owned(orgA, report));
      expect((await patch(reportT, lead.id, {}).expect(400)).body.code).toBe('EMPTY_UPDATE');
      for (const body of [
        { firstName: null },
        { lastName: null },
        { source: null },
        { source: 'TELEPATHY' },
        { ownerId: null },
        { organizationId: orgB.id },
        { deletedAt: null },
        { email: 'nope' },
      ]) {
        const res = await patch(reportT, lead.id, body).expect(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
    });

    it('400 for score, status and conversion fields; the lead is unchanged', async () => {
      const lead = await createLead(prisma, owned(orgA, report), { score: 10 });
      for (const body of [
        { score: 100 },
        { status: 'QUALIFIED' },
        { status: 'CONVERTED' },
        { convertedAt: '2020-01-01T00:00:00.000Z' },
        { convertedContactId: MISSING_ID },
        { convertedDealId: MISSING_ID },
        { notes: 'ok', score: 100 },
      ]) {
        const res = await patch(reportT, lead.id, body).expect(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
      const stored = await row(lead.id);
      expect(stored).toMatchObject({ score: 10, status: 'NEW', convertedAt: null, notes: null });
    });

    it('404 for a lead the caller cannot see, with no change made', async () => {
      const theirs = await createLead(prisma, owned(orgA, repX));
      await patch(reportT, theirs.id, { notes: 'Hacked' }).expect(404);
      await patch(reportT, theirs.id, { ownerId: report.id }).expect(404);
      await patch(reportT, theirs.id, { email: 'a@b.co' }).expect(404);
      const stored = await row(theirs.id);
      expect(stored.notes).toBeNull();
      expect(stored.ownerId).toBe(repX.id);
      expect(stored.score).toBe(0);
    });

    describe('scoring', () => {
      it('changing source, email, phone or companyName recomputes the score', async () => {
        const lead = await createLead(prisma, owned(orgA, report)); // OTHER, nothing filled: 0
        const score = async (body: object) =>
          (await patch(reportT, lead.id, body).expect(200)).body.score as number;
        expect(await score({ source: 'REFERRAL' })).toBe(40);
        expect(await score({ email: 'a@b.co' })).toBe(60);
        expect(await score({ phone: '12345' })).toBe(75);
        expect(await score({ companyName: 'Acme' })).toBe(85);
        expect(await score({ email: null })).toBe(65);
        expect(await score({ companyName: '  ' })).toBe(55);
        expect(await score({ source: 'COLD_CALL', phone: null })).toBe(10);
        expect((await row(lead.id)).score).toBe(10);
      });

      it('the score is merged with the STORED fields, not only the ones sent', async () => {
        const lead = await createLead(prisma, owned(orgA, report), {
          source: 'WEBSITE',
          email: 'a@b.co',
        });
        const res = await patch(reportT, lead.id, { phone: '12345' }).expect(200);
        expect(res.body.score).toBe(30 + 20 + 15);
      });

      it('a non-scoring change leaves the score exactly as stored', async () => {
        // 77 is deliberately not what the rules would give: any recomputation would show.
        const lead = await createLead(prisma, owned(orgA, report), { score: 77 });
        await patch(reportT, lead.id, { notes: 'call back', firstName: 'Nora' }).expect(200);
        await patch(adminT, lead.id, { ownerId: repX.id }).expect(200);
        expect((await row(lead.id)).score).toBe(77);
      });

      it('a non-scoring or owner-only change takes no lock; a scoring change waits for the lead lock', async () => {
        const lead = await createLead(prisma, owned(orgA, report));
        let release!: () => void;
        let acquired!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const held = new Promise<void>((resolve) => (acquired = resolve));
        const holder = prisma.$transaction(
          async (tx) => {
            await acquireLock(tx, 'lead', lead.id);
            acquired();
            await gate;
          },
          { timeout: 30_000 },
        );
        await held;

        // Not blocked by the held lock:
        await patch(reportT, lead.id, { notes: 'free' }).expect(200);
        await patch(adminT, lead.id, { ownerId: repX.id }).expect(200);

        let settled = false;
        const scoring = Promise.resolve(patch(adminT, lead.id, { email: 'a@b.co' })).then((res) => {
          settled = true;
          return res;
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(settled).toBe(false);

        release();
        await holder;
        const res = await scoring;
        expect(res.status).toBe(200);
        expect(res.body.score).toBe(20);
      });

      it('concurrent updates of DIFFERENT scoring fields leave the correct final score', async () => {
        for (let i = 0; i < RACE_ITERATIONS; i += 1) {
          const lead = await createLead(prisma, owned(orgA, report)); // OTHER: 0
          const results = await Promise.all([
            patch(reportT, lead.id, { email: 'a@b.co' }),
            patch(reportT, lead.id, { phone: '12345' }),
            patch(reportT, lead.id, { companyName: 'Acme' }),
          ]);
          for (const res of results) expect(res.status).toBe(200);
          expect(await row(lead.id)).toMatchObject({
            email: 'a@b.co',
            phone: '12345',
            companyName: 'Acme',
            score: 20 + 15 + 10,
          });
        }
      });
    });

    describe('ownership transfer', () => {
      it('a rep cannot transfer; a manager can within the team; an admin anywhere', async () => {
        const lead = await createLead(prisma, owned(orgA, report));
        expect((await patch(reportT, lead.id, { ownerId: repX.id }).expect(400)).body.code).toBe(
          'INVALID_OWNER',
        );
        await patch(managerT, lead.id, { ownerId: manager.id }).expect(200);
        expect((await patch(managerT, lead.id, { ownerId: repX.id }).expect(400)).body.code).toBe(
          'INVALID_OWNER',
        );
        await patch(adminT, lead.id, { ownerId: repX.id }).expect(200);
        expect((await row(lead.id)).ownerId).toBe(repX.id);
      });

      it('an unchanged ownerId is not re-validated (inactive owner stays editable)', async () => {
        const lead = await createLead(prisma, owned(orgA, inactiveReport));
        await patch(managerT, lead.id, { ownerId: inactiveReport.id, notes: 'kept' }).expect(200);
        await patch(managerT, lead.id, { ownerId: orgA.admin.id }).expect(400);
      });

      it('a transfer and a scoring change in one request apply together', async () => {
        const lead = await createLead(prisma, owned(orgA, report));
        const res = await patch(adminT, lead.id, { ownerId: repX.id, source: 'PARTNER' }).expect(
          200,
        );
        expect(res.body).toMatchObject({ ownerId: repX.id, score: 35 });
      });

      it('after a transfer away, the previous owner gets 404', async () => {
        const lead = await createLead(prisma, owned(orgA, report));
        await patch(adminT, lead.id, { ownerId: repX.id }).expect(200);
        await patch(reportT, lead.id, { notes: 'Late' }).expect(404);
        await patch(reportT, lead.id, { email: 'late@b.co' }).expect(404);
      });
    });
  });

  describe('delete', () => {
    it('204 soft-deletes: the row stays with deletedAt; later reads and writes are 404', async () => {
      const lead = await createLead(prisma, owned(orgA, report));
      await http().delete(`${API}/${lead.id}`).set(as(reportT)).expect(204);
      expect((await row(lead.id)).deletedAt).not.toBeNull();
      await http().get(`${API}/${lead.id}`).set(as(reportT)).expect(404);
      await patch(reportT, lead.id, { notes: 'X' }).expect(404);
      await patch(reportT, lead.id, { email: 'a@b.co' }).expect(404);
      await http().delete(`${API}/${lead.id}`).set(as(reportT)).expect(404);
    });

    it('404 for a lead the caller cannot see, which stays untouched', async () => {
      const theirs = await createLead(prisma, owned(orgA, repX));
      await http().delete(`${API}/${theirs.id}`).set(as(reportT)).expect(404);
      expect((await row(theirs.id)).deletedAt).toBeNull();
    });

    it('a manager deletes a report lead', async () => {
      const lead = await createLead(prisma, owned(orgA, report));
      await http().delete(`${API}/${lead.id}`).set(as(managerT)).expect(204);
    });
  });

  describe('status', () => {
    type Status = 'NEW' | 'CONTACTED' | 'QUALIFIED' | 'UNQUALIFIED' | 'CONVERTED';
    const ALLOWED: Record<Status, Status[]> = {
      NEW: ['CONTACTED', 'UNQUALIFIED'],
      CONTACTED: ['QUALIFIED', 'UNQUALIFIED'],
      QUALIFIED: ['UNQUALIFIED'],
      UNQUALIFIED: ['CONTACTED'],
      CONVERTED: [],
    };
    const SETTABLE: Status[] = ['NEW', 'CONTACTED', 'QUALIFIED', 'UNQUALIFIED'];
    const move = (tokens: Tokens, id: string, body: object) =>
      http().post(`${API}/${id}/status`).set(as(tokens)).send(body);
    // 77 is not what the rules would compute for these leads: any recomputation would show.
    const leadIn = (status: Status, owner: TestUser = report) =>
      createLead(prisma, owned(orgA, owner), { status, score: 77 });

    it('401 without a token; 403 without leads:update', async () => {
      const lead = await leadIn('NEW', nobody);
      await http().post(`${API}/${lead.id}/status`).send({ status: 'CONTACTED' }).expect(401);
      const res = await move(await signIn(nobody), lead.id, { status: 'CONTACTED' }).expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    for (const from of Object.keys(ALLOWED) as Status[]) {
      it(`from ${from}: only ${ALLOWED[from].join(', ') || 'nothing'} is possible`, async () => {
        for (const to of SETTABLE) {
          const lead = await leadIn(from);
          const before = await row(lead.id);
          const res = await move(reportT, lead.id, { status: to });
          const after = await row(lead.id);

          if (ALLOWED[from].includes(to)) {
            expect(res.status, `${from} -> ${to}`).toBe(200);
            expect(res.body).toMatchObject({ id: lead.id, status: to, score: 77 });
            expect(after.status).toBe(to);
            expect(after.score).toBe(77);
            expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
          } else {
            // Rejected: status, score and updatedAt are exactly as they were.
            expect(res.status, `${from} -> ${to}`).toBe(409);
            expect(res.body.code).toBe(
              from === 'CONVERTED' ? 'LEAD_ALREADY_CONVERTED' : 'INVALID_STATUS_TRANSITION',
            );
            expect(after.status).toBe(from);
            expect(after.score).toBe(77);
            expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
          }
        }
      });
    }

    it('a full lifecycle, including the reopen back to CONTACTED', async () => {
      const lead = await leadIn('NEW');
      for (const status of ['CONTACTED', 'QUALIFIED', 'UNQUALIFIED', 'CONTACTED', 'QUALIFIED']) {
        expect((await move(reportT, lead.id, { status }).expect(200)).body.status).toBe(status);
      }
    });

    it('retrying an already-applied change is 409 (not idempotent): GET to confirm', async () => {
      const lead = await leadIn('NEW');
      await move(reportT, lead.id, { status: 'CONTACTED' }).expect(200);
      const retry = await move(reportT, lead.id, { status: 'CONTACTED' }).expect(409);
      expect(retry.body.code).toBe('INVALID_STATUS_TRANSITION');
      const current = await http().get(`${API}/${lead.id}`).set(as(reportT)).expect(200);
      expect(current.body.status).toBe('CONTACTED');
    });

    it('400 for CONVERTED, an unknown status, a missing status or a bad id', async () => {
      const lead = await leadIn('NEW');
      for (const body of [{ status: 'CONVERTED' }, { status: 'DONE' }, { status: null }, {}]) {
        const res = await move(reportT, lead.id, body).expect(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
      await move(reportT, 'nope', { status: 'CONTACTED' }).expect(400);
      expect((await row(lead.id)).status).toBe('NEW');
    });

    it('400 for any field besides `status`: the client never supplies `from`, score, owner or conversion data', async () => {
      const lead = await leadIn('NEW');
      for (const extra of [
        { from: 'NEW' },
        { from: 'CONVERTED' },
        { convertedAt: '2020-01-01T00:00:00.000Z' },
        { score: 100 },
        { ownerId: repX.id },
        { organizationId: orgB.id },
        { convertedContactId: MISSING_ID },
      ]) {
        const res = await move(reportT, lead.id, { status: 'CONTACTED', ...extra }).expect(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
      expect(await row(lead.id)).toMatchObject({
        status: 'NEW',
        score: 77,
        ownerId: report.id,
        convertedAt: null,
      });
    });

    it('the status does not change the score and takes no lead lock', async () => {
      const lead = await leadIn('NEW');
      let release!: () => void;
      let acquired!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const held = new Promise<void>((resolve) => (acquired = resolve));
      const holder = prisma.$transaction(
        async (tx) => {
          await acquireLock(tx, 'lead', lead.id);
          acquired();
          await gate;
        },
        { timeout: 30_000 },
      );
      await held;
      try {
        // Would hang until the lock is released if the status change took it.
        const res = await move(reportT, lead.id, { status: 'CONTACTED' }).expect(200);
        expect(res.body.score).toBe(77);
      } finally {
        release();
        await holder;
      }
    });

    describe('visibility', () => {
      it('a rep changes their own lead; a manager the lead of a direct report; an admin any', async () => {
        await move(reportT, (await leadIn('NEW')).id, { status: 'CONTACTED' }).expect(200);
        await move(managerT, (await leadIn('NEW', report)).id, { status: 'CONTACTED' }).expect(200);
        await move(managerT, (await leadIn('NEW', manager)).id, { status: 'CONTACTED' }).expect(
          200,
        );
        await move(adminT, (await leadIn('NEW', repX)).id, { status: 'CONTACTED' }).expect(200);
      });

      it('a manager cannot change a lead owned by someone outside the team: 404, untouched', async () => {
        const lead = await leadIn('NEW', repX);
        const res = await move(managerT, lead.id, { status: 'CONTACTED' }).expect(404);
        expect(res.body.code).toBe('RESOURCE_NOT_FOUND');
        expect((await row(lead.id)).status).toBe('NEW');
      });

      it('a rep cannot change a colleague lead, a missing, deleted or other-organization one: all 404', async () => {
        const theirs = await leadIn('NEW', repX);
        const deleted = await createLead(prisma, owned(orgA, report), { deletedAt: new Date() });
        const foreign = await createLead(prisma, owned(orgB, repB));
        for (const id of [theirs.id, MISSING_ID, deleted.id, foreign.id]) {
          const res = await move(reportT, id, { status: 'CONTACTED' }).expect(404);
          expect(res.body.code).toBe('RESOURCE_NOT_FOUND');
        }
        expect((await row(theirs.id)).status).toBe('NEW');
        expect((await row(foreign.id)).status).toBe('NEW');
      });

      it('an invisible CONVERTED lead is 404, never 409 (its state is not revealed)', async () => {
        const theirs = await leadIn('CONVERTED', repX);
        const foreign = await createLead(prisma, owned(orgB, repB), { status: 'CONVERTED' });
        await move(reportT, theirs.id, { status: 'CONTACTED' }).expect(404);
        await move(managerT, theirs.id, { status: 'CONTACTED' }).expect(404);
        await move(adminT, foreign.id, { status: 'CONTACTED' }).expect(404);
        // ...while the same lead is a 409 for someone who can see it.
        await move(adminT, theirs.id, { status: 'CONTACTED' }).expect(409);
      });

      it('after a transfer away, the previous owner gets 404', async () => {
        const lead = await leadIn('NEW');
        await patch(adminT, lead.id, { ownerId: repX.id }).expect(200);
        await move(reportT, lead.id, { status: 'CONTACTED' }).expect(404);
      });
    });

    // Without the `status = from` guard on the write, two requests that both read NEW would both
    // return 200 and the last write would win silently.
    describe('concurrent changes (compare-and-set)', () => {
      // Two different targets can legitimately BOTH succeed when one request finishes before the
      // other starts (NEW -> CONTACTED, then CONTACTED -> UNQUALIFIED), so this asserts the invariant
      // rather than one outcome: a 409 is always INVALID_STATUS_TRANSITION and means the stored
      // status is the other request's target; two 200s mean the requests ran one after the other.
      it('NEW -> CONTACTED racing NEW -> UNQUALIFIED never loses or invents an update', async () => {
        for (let i = 0; i < RACE_ITERATIONS; i += 1) {
          const lead = await leadIn('NEW');
          const targets: Status[] = ['CONTACTED', 'UNQUALIFIED'];
          const results = await Promise.all(
            targets.map((status) => move(reportT, lead.id, { status })),
          );
          const stored = (await row(lead.id)).status as Status;
          const codes = results.map((res) => res.status);
          expect(codes.every((code) => code === 200 || code === 409)).toBe(true);
          expect(codes).toContain(200);
          expect(targets).toContain(stored);
          if (codes.includes(409)) {
            expect(results.find((res) => res.status === 409)?.body.code).toBe(
              'INVALID_STATUS_TRANSITION',
            );
            expect(stored).toBe(targets[results.findIndex((res) => res.status === 200)]);
          }
        }
      });

      // Deterministic: whichever runs second finds CONTACTED, and CONTACTED -> CONTACTED is never
      // allowed. This is the test that fails when the compare-and-set guard is removed.
      it('the same change sent twice at once is applied once', async () => {
        for (let i = 0; i < RACE_ITERATIONS; i += 1) {
          const lead = await leadIn('NEW');
          const results = await Promise.all([
            move(reportT, lead.id, { status: 'CONTACTED' }),
            move(reportT, lead.id, { status: 'CONTACTED' }),
          ]);
          expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
        }
      });
    });
  });

  describe('converted leads are final', () => {
    const converted = () =>
      createLead(prisma, owned(orgA, report), { status: 'CONVERTED', score: 55, notes: 'kept' });

    it('PATCH is 409 LEAD_ALREADY_CONVERTED for every kind of change, and nothing is written', async () => {
      const lead = await converted();
      for (const [tokens, body] of [
        [reportT, { notes: 'edited' }],
        [reportT, { firstName: 'Edited' }],
        [reportT, { email: 'a@b.co' }], // a scoring field: no recompute either
        [reportT, { source: 'REFERRAL' }],
        [managerT, { notes: 'edited' }],
        [adminT, { ownerId: repX.id }], // owner transfer is blocked too (ADR 0008)
        [adminT, { ownerId: repX.id, notes: 'edited' }],
      ] as [Tokens, object][]) {
        const res = await patch(tokens, lead.id, body).expect(409);
        expect(res.body.code).toBe('LEAD_ALREADY_CONVERTED');
      }
      expect(await row(lead.id)).toMatchObject({
        notes: 'kept',
        email: null,
        score: 55,
        ownerId: report.id,
        firstName: 'Lead',
      });
    });

    it('an empty PATCH is 400 EMPTY_UPDATE, before the 409 is considered', async () => {
      const lead = await converted();
      expect((await patch(reportT, lead.id, {}).expect(400)).body.code).toBe('EMPTY_UPDATE');
    });

    it('a bad body is 400 VALIDATION_FAILED, not 409', async () => {
      const lead = await converted();
      expect((await patch(reportT, lead.id, { score: 1 }).expect(400)).body.code).toBe(
        'VALIDATION_FAILED',
      );
    });

    it('DELETE is 409 and the lead stays', async () => {
      const lead = await converted();
      const res = await http().delete(`${API}/${lead.id}`).set(as(reportT)).expect(409);
      expect(res.body.code).toBe('LEAD_ALREADY_CONVERTED');
      expect((await row(lead.id)).deletedAt).toBeNull();
    });

    it('a converted lead the caller cannot see answers 404 to PATCH and DELETE', async () => {
      const lead = await converted();
      await patch(repXT, lead.id, { notes: 'x' }).expect(404);
      await patch(repBT, lead.id, { notes: 'x' }).expect(404);
      await http().delete(`${API}/${lead.id}`).set(as(repXT)).expect(404);
      await http().delete(`${API}/${lead.id}`).set(as(repBT)).expect(404);
    });

    it('it can still be read, listed and filtered', async () => {
      const lead = await converted();
      const got = await http().get(`${API}/${lead.id}`).set(as(reportT)).expect(200);
      expect(got.body.status).toBe('CONVERTED');
      const list = await http().get(`${API}?status=CONVERTED`).set(as(reportT)).expect(200);
      expect(ids(list)).toEqual([lead.id]);
    });
  });

  describe('tenant isolation', () => {
    it('organization B can never read, update, delete or list organization A leads', async () => {
      const lead = await createLead(prisma, owned(orgA, report));
      await http().get(`${API}/${lead.id}`).set(as(repBT)).expect(404);
      await patch(repBT, lead.id, { notes: 'Hacked' }).expect(404);
      await patch(repBT, lead.id, { email: 'h@x.co' }).expect(404);
      await http().delete(`${API}/${lead.id}`).set(as(repBT)).expect(404);
      const list = await http().get(API).set(as(repBT)).expect(200);
      expect(list.body.data).toEqual([]);
      expect(list.body.meta.total).toBe(0);
      const stored = await row(lead.id);
      expect(stored).toMatchObject({ notes: null, email: null, score: 0, deletedAt: null });
    });

    it('an organization A admin cannot touch organization B leads', async () => {
      const lead = await createLead(prisma, owned(orgB, repB));
      await http().get(`${API}/${lead.id}`).set(as(adminT)).expect(404);
      await patch(adminT, lead.id, { notes: 'Hacked' }).expect(404);
      await http().delete(`${API}/${lead.id}`).set(as(adminT)).expect(404);
      const list = await http().get(API).set(as(adminT)).expect(200);
      expect(list.body.data).toEqual([]);
    });

    it('cannot hand a lead to a user of another organization', async () => {
      const lead = await createLead(prisma, owned(orgA, report));
      expect((await patch(adminT, lead.id, { ownerId: repB.id }).expect(400)).body.code).toBe(
        'INVALID_OWNER',
      );
      expect((await row(lead.id)).ownerId).toBe(report.id);
    });
  });
});
