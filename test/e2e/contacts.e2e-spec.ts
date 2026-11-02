import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '../../prisma/seed/prisma-client';
import { ROLE_NAMES } from '../../prisma/seed/permissions';
import { createCompany, createContact } from '../factories/crm.factory';
import { createTestPrisma, resetDatabase } from '../factories/database';
import {
  createCustomRole,
  createOrganization,
  createUser,
  type TestOrganization,
  type TestUser,
} from '../factories/organization.factory';
import { createTestApp } from '../setup/create-test-app';

const API = '/api/v1/contacts';
const COMPANIES_API = '/api/v1/companies';
const RACE_ITERATIONS = 20;

interface Tokens {
  accessToken: string;
}

describe('Contacts (e2e)', () => {
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
  const row = (id: string) => prisma.contact.findUniqueOrThrow({ where: { id } });
  const ids = (res: request.Response): string[] =>
    (res.body.data as { id: string }[]).map(({ id }) => id).sort();
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
      const contact = await createContact(prisma, owned(orgA, report));
      await http().get(API).expect(401);
      await http().get(`${API}/${contact.id}`).expect(401);
      await http().post(API).send({ firstName: 'A', lastName: 'B' }).expect(401);
      await http().patch(`${API}/${contact.id}`).send({ firstName: 'X' }).expect(401);
      await http().delete(`${API}/${contact.id}`).expect(401);
    });

    it('403 FORBIDDEN without the matching permission, on every route', async () => {
      const t = await signIn(nobody);
      const contact = await createContact(prisma, owned(orgA, nobody));
      for (const res of [
        await http().get(API).set(as(t)),
        await http().get(`${API}/${contact.id}`).set(as(t)),
        await http().post(API).set(as(t)).send({ firstName: 'A', lastName: 'B' }),
        await http().patch(`${API}/${contact.id}`).set(as(t)).send({ firstName: 'X' }),
        await http().delete(`${API}/${contact.id}`).set(as(t)),
      ]) {
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('FORBIDDEN');
      }
    });
  });

  describe('create', () => {
    it('201: the owner defaults to the caller; text is trimmed and email lowercased', async () => {
      const res = await post(reportT, {
        firstName: '  Sara ',
        lastName: ' Hassan  ',
        email: ' Sara@ACME.com ',
        phone: '+20 100 123 4567',
        jobTitle: '  Head of Procurement ',
      }).expect(201);
      expect(res.body).toMatchObject({
        firstName: 'Sara',
        lastName: 'Hassan',
        email: 'sara@acme.com',
        phone: '+20 100 123 4567',
        jobTitle: 'Head of Procurement',
        companyId: null,
        ownerId: report.id,
      });
      expect(Object.keys(res.body).sort()).toEqual(
        [
          'companyId',
          'createdAt',
          'email',
          'firstName',
          'id',
          'jobTitle',
          'lastName',
          'ownerId',
          'phone',
          'updatedAt',
        ].sort(),
      );
      expect((await row(res.body.id)).organizationId).toBe(orgA.id);
    });

    it('email is optional (the ERD column is nullable); blank is stored as NULL', async () => {
      const none = await post(reportT, { firstName: 'A', lastName: 'B' }).expect(201);
      expect(none.body.email).toBeNull();
      const blank = await post(reportT, { firstName: 'A', lastName: 'B', email: '  ' }).expect(201);
      expect(blank.body.email).toBeNull();
    });

    it('allows duplicate emails (the ERD has no uniqueness)', async () => {
      const body = { firstName: 'A', lastName: 'B', email: 'twin@acme.com' };
      await post(reportT, body).expect(201);
      await post(reportT, body).expect(201);
    });

    it('400 VALIDATION_FAILED on bad input', async () => {
      const ok = { firstName: 'A', lastName: 'B' };
      const bad: object[] = [
        {},
        { firstName: 'A' },
        { lastName: 'B' },
        { ...ok, firstName: '   ' },
        { ...ok, lastName: 'x'.repeat(101) },
        { ...ok, email: 'not-an-email' },
        { ...ok, phone: 'call me' },
        { ...ok, jobTitle: 'x'.repeat(101) },
        { ...ok, companyId: 'not-a-uuid' },
        { ...ok, ownerId: 'not-a-uuid' },
        { ...ok, firstName: 5 },
      ];
      for (const body of bad) {
        const res = await post(reportT, body).expect(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
    });

    it('400 for organizationId, deletedAt, createdAt, id in the body', async () => {
      for (const extra of [
        { organizationId: orgB.id },
        { deletedAt: null },
        { createdAt: '2020-01-01T00:00:00.000Z' },
        { id: '11111111-1111-4111-8111-111111111111' },
      ]) {
        const res = await post(reportT, { firstName: 'A', lastName: 'B', ...extra }).expect(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
      expect(await prisma.contact.count()).toBe(0);
    });

    describe('owner assignment', () => {
      const create = (tokens: Tokens, ownerId: string) =>
        post(tokens, { firstName: 'A', lastName: 'B', ownerId });

      it('a rep may name only themselves', async () => {
        await create(reportT, report.id).expect(201);
        for (const target of [repX.id, manager.id, orgA.admin.id]) {
          expect((await create(reportT, target).expect(400)).body.code).toBe('INVALID_OWNER');
        }
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
    });

    describe('linking a company', () => {
      it('a rep links their own company', async () => {
        const company = await createCompany(prisma, owned(orgA, report));
        const res = await post(reportT, {
          firstName: 'A',
          lastName: 'B',
          companyId: company.id,
        }).expect(201);
        expect(res.body.companyId).toBe(company.id);
      });

      it('a manager links a company owned by their report', async () => {
        const company = await createCompany(prisma, owned(orgA, report));
        await post(managerT, { firstName: 'A', lastName: 'B', companyId: company.id }).expect(201);
      });

      it('a rep cannot link a company they cannot see: 400 INVALID_COMPANY', async () => {
        const hidden = await createCompany(prisma, owned(orgA, repX));
        const res = await post(reportT, {
          firstName: 'A',
          lastName: 'B',
          companyId: hidden.id,
        }).expect(400);
        expect(res.body.code).toBe('INVALID_COMPANY');
        expect(await prisma.contact.count()).toBe(0);
      });

      it('missing, deleted, foreign-organization and not-visible companies answer identically', async () => {
        const deleted = await createCompany(
          prisma,
          {
            ...owned(orgA, report),
          },
          { deletedAt: new Date() },
        );
        const foreign = await createCompany(prisma, owned(orgB, repB));
        const hidden = await createCompany(prisma, owned(orgA, repX));
        const missing = '11111111-1111-4111-8111-111111111111';
        const answers = [];
        for (const companyId of [missing, deleted.id, foreign.id, hidden.id]) {
          const res = await post(reportT, { firstName: 'A', lastName: 'B', companyId }).expect(400);
          answers.push({ code: res.body.code, message: res.body.message });
        }
        expect(answers[0].code).toBe('INVALID_COMPANY');
        for (const answer of answers) expect(answer).toEqual(answers[0]);
      });

      it('an admin links any company of their own organization, not another one', async () => {
        const company = await createCompany(prisma, owned(orgA, repX));
        await post(adminT, { firstName: 'A', lastName: 'B', companyId: company.id }).expect(201);
        const foreign = await createCompany(prisma, owned(orgB, repB));
        const res = await post(adminT, {
          firstName: 'A',
          lastName: 'B',
          companyId: foreign.id,
        }).expect(400);
        expect(res.body.code).toBe('INVALID_COMPANY');
      });
    });
  });

  describe('list', () => {
    it('shows each role only what it may see (own / team / organization)', async () => {
      const mine = await createContact(prisma, owned(orgA, report));
      const managers = await createContact(prisma, owned(orgA, manager));
      const inactives = await createContact(prisma, owned(orgA, inactiveReport));
      const others = await createContact(prisma, owned(orgA, repX));
      await createContact(prisma, owned(orgB, repB));
      await createContact(prisma, owned(orgA, report), { deletedAt: new Date() });

      const get = async (tokens: Tokens) => ids(await http().get(API).set(as(tokens)).expect(200));
      expect(await get(reportT)).toEqual([mine.id]);
      expect(await get(managerT)).toEqual([mine.id, managers.id, inactives.id].sort());
      expect(await get(adminT)).toEqual([mine.id, managers.id, inactives.id, others.id].sort());
    });

    it('the total counts only visible rows; pagination is stable', async () => {
      for (let i = 0; i < 3; i += 1) await createContact(prisma, owned(orgA, report));
      await createContact(prisma, owned(orgA, repX));
      const res = await http().get(`${API}?limit=2&page=2`).set(as(reportT)).expect(200);
      expect(res.body.meta).toEqual({ page: 2, limit: 2, total: 3, totalPages: 2 });
      expect(res.body.data).toHaveLength(1);
    });

    it('?ownerId narrows but never widens', async () => {
      const mine = await createContact(prisma, owned(orgA, report));
      await createContact(prisma, owned(orgA, repX));
      const own = await http().get(`${API}?ownerId=${report.id}`).set(as(reportT)).expect(200);
      expect(ids(own)).toEqual([mine.id]);
      const other = await http().get(`${API}?ownerId=${repX.id}`).set(as(reportT)).expect(200);
      expect(other.body.data).toEqual([]);
      expect(other.body.meta.total).toBe(0);
    });

    it('?companyId filters; an invisible company id yields an empty 200', async () => {
      const company = await createCompany(prisma, owned(orgA, report));
      const hidden = await createCompany(prisma, owned(orgA, repX));
      const linked = await createContact(prisma, owned(orgA, report), { companyId: company.id });
      await createContact(prisma, owned(orgA, report));
      await createContact(prisma, owned(orgA, repX), { companyId: hidden.id });

      const filtered = await http()
        .get(`${API}?companyId=${company.id}`)
        .set(as(reportT))
        .expect(200);
      expect(ids(filtered)).toEqual([linked.id]);

      const invisible = await http()
        .get(`${API}?companyId=${hidden.id}`)
        .set(as(reportT))
        .expect(200);
      expect(invisible.body.data).toEqual([]);
      expect(invisible.body.meta.total).toBe(0);
    });

    it('?q searches name, email and job title case-insensitively; % and _ are literal', async () => {
      const sara = await createContact(prisma, owned(orgA, report), { firstName: 'Sara' });
      const mail = await createContact(prisma, owned(orgA, report), { email: 'x@findme.io' });
      const pct = await prisma.contact.create({
        data: {
          ...owned(orgA, report),
          firstName: 'Rate',
          lastName: 'Fifty',
          jobTitle: '50% off',
        },
      });
      const search = async (q: string) =>
        ids(await http().get(API).query({ q }).set(as(reportT)).expect(200));
      expect(await search('SARA')).toEqual([sara.id]);
      expect(await search('FINDME')).toEqual([mail.id]);
      expect(await search('50%')).toEqual([pct.id]);
      expect(await search('%')).toEqual([pct.id]);
      expect(await search('_')).toEqual([]);
    });

    it('400 INVALID_SORT_FIELD for a field outside the whitelist; sorting by lastName works', async () => {
      const res = await http().get(`${API}?sortBy=email`).set(as(reportT)).expect(400);
      expect(res.body.code).toBe('INVALID_SORT_FIELD');
      await http().get(`${API}?sortBy=lastName&sortOrder=asc`).set(as(reportT)).expect(200);
    });
  });

  describe('get', () => {
    it('200 for a visible contact, with the documented shape', async () => {
      const contact = await createContact(prisma, owned(orgA, report));
      const res = await http().get(`${API}/${contact.id}`).set(as(reportT)).expect(200);
      expect(res.body.id).toBe(contact.id);
      expect(res.body).not.toHaveProperty('organizationId');
      expect(res.body).not.toHaveProperty('deletedAt');
    });

    it('404 for missing, deleted, not-visible and other-organization contacts; 400 for a bad id', async () => {
      const theirs = await createContact(prisma, owned(orgA, repX));
      const deleted = await createContact(prisma, owned(orgA, report), { deletedAt: new Date() });
      const foreign = await createContact(prisma, owned(orgB, repB));
      for (const id of [
        '11111111-1111-4111-8111-111111111111',
        theirs.id,
        deleted.id,
        foreign.id,
      ]) {
        const res = await http().get(`${API}/${id}`).set(as(reportT)).expect(404);
        expect(res.body.code).toBe('RESOURCE_NOT_FOUND');
      }
      await http().get(`${API}/nope`).set(as(reportT)).expect(400);
    });

    it('a manager reads a report contact; a rep outside the team does not', async () => {
      const contact = await createContact(prisma, owned(orgA, report));
      await http().get(`${API}/${contact.id}`).set(as(managerT)).expect(200);
      await http().get(`${API}/${contact.id}`).set(as(repXT)).expect(404);
    });
  });

  describe('update', () => {
    it('edits fields and clears optional ones with null or a blank string', async () => {
      const contact = await createContact(prisma, owned(orgA, report));
      await prisma.contact.update({
        where: { id: contact.id },
        data: { email: 'a@b.co', phone: '12345', jobTitle: 'CEO' },
      });
      const res = await patch(reportT, contact.id, {
        firstName: ' Nora ',
        email: null,
        phone: '  ',
        jobTitle: null,
      }).expect(200);
      expect(res.body).toMatchObject({
        firstName: 'Nora',
        email: null,
        phone: null,
        jobTitle: null,
      });
    });

    it('lowercases a new email', async () => {
      const contact = await createContact(prisma, owned(orgA, report));
      const res = await patch(reportT, contact.id, { email: ' New@Mail.COM ' }).expect(200);
      expect(res.body.email).toBe('new@mail.com');
    });

    it('400 EMPTY_UPDATE for an empty body; 400 for null on NOT NULL fields and unknown fields', async () => {
      const contact = await createContact(prisma, owned(orgA, report));
      expect((await patch(reportT, contact.id, {}).expect(400)).body.code).toBe('EMPTY_UPDATE');
      for (const body of [
        { firstName: null },
        { lastName: null },
        { ownerId: null },
        { organizationId: orgB.id },
        { deletedAt: null },
        { email: 'nope' },
      ]) {
        const res = await patch(reportT, contact.id, body).expect(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
    });

    it('404 for a contact the caller cannot see, with no change made', async () => {
      const theirs = await createContact(prisma, owned(orgA, repX));
      await patch(reportT, theirs.id, { firstName: 'Hacked' }).expect(404);
      await patch(reportT, theirs.id, { ownerId: report.id }).expect(404);
      expect((await row(theirs.id)).firstName).not.toBe('Hacked');
      expect((await row(theirs.id)).ownerId).toBe(repX.id);
    });

    describe('company link', () => {
      it('links a visible company, then unlinks with null', async () => {
        const company = await createCompany(prisma, owned(orgA, report));
        const contact = await createContact(prisma, owned(orgA, report));
        expect(
          (await patch(reportT, contact.id, { companyId: company.id }).expect(200)).body.companyId,
        ).toBe(company.id);
        expect(
          (await patch(reportT, contact.id, { companyId: null }).expect(200)).body.companyId,
        ).toBeNull();
      });

      it('400 INVALID_COMPANY for a company the rep cannot see; the contact is unchanged', async () => {
        const hidden = await createCompany(prisma, owned(orgA, repX));
        const contact = await createContact(prisma, owned(orgA, report));
        const res = await patch(reportT, contact.id, { companyId: hidden.id }).expect(400);
        expect(res.body.code).toBe('INVALID_COMPANY');
        expect((await row(contact.id)).companyId).toBeNull();
      });

      it('a manager may move a report contact to a company owned by another report', async () => {
        const company = await createCompany(prisma, owned(orgA, report));
        const contact = await createContact(prisma, owned(orgA, manager));
        await patch(managerT, contact.id, { companyId: company.id }).expect(200);
      });

      it('a rep can edit a contact whose company moved to someone else when companyId is unchanged', async () => {
        const company = await createCompany(prisma, owned(orgA, report));
        const contact = await createContact(prisma, owned(orgA, report), {
          companyId: company.id,
        });
        await prisma.company.update({ where: { id: company.id }, data: { ownerId: repX.id } });

        const res = await patch(reportT, contact.id, {
          companyId: company.id,
          firstName: 'Still',
        }).expect(200);
        expect(res.body).toMatchObject({ firstName: 'Still', companyId: company.id });
        await patch(reportT, contact.id, { jobTitle: 'Ops' }).expect(200);
        // ...but moving it to a different company the rep cannot see is rejected.
        const another = await createCompany(prisma, owned(orgA, repX));
        await patch(reportT, contact.id, { companyId: another.id }).expect(400);
      });

      it('unlinking works even when the old company is no longer visible', async () => {
        const company = await createCompany(prisma, owned(orgA, repX));
        const contact = await createContact(prisma, owned(orgA, report), {
          companyId: company.id,
        });
        await patch(reportT, contact.id, { companyId: null }).expect(200);
      });
    });

    describe('ownership transfer', () => {
      it('a rep cannot transfer; a manager can within the team; an admin anywhere', async () => {
        const contact = await createContact(prisma, owned(orgA, report));
        expect((await patch(reportT, contact.id, { ownerId: repX.id }).expect(400)).body.code).toBe(
          'INVALID_OWNER',
        );
        await patch(managerT, contact.id, { ownerId: manager.id }).expect(200);
        expect(
          (await patch(managerT, contact.id, { ownerId: repX.id }).expect(400)).body.code,
        ).toBe('INVALID_OWNER');
        await patch(adminT, contact.id, { ownerId: repX.id }).expect(200);
        expect((await row(contact.id)).ownerId).toBe(repX.id);
      });

      it('an unchanged ownerId is not re-validated (inactive owner stays editable)', async () => {
        const contact = await createContact(prisma, owned(orgA, inactiveReport));
        await patch(managerT, contact.id, {
          ownerId: inactiveReport.id,
          firstName: 'Kept',
        }).expect(200);
        await patch(managerT, contact.id, { ownerId: orgA.admin.id }).expect(400);
      });

      it('after a transfer away, the previous owner gets 404', async () => {
        const contact = await createContact(prisma, owned(orgA, report));
        await patch(adminT, contact.id, { ownerId: repX.id }).expect(200);
        await patch(reportT, contact.id, { firstName: 'Late' }).expect(404);
      });
    });
  });

  describe('delete', () => {
    it('204 soft-deletes: the row stays with deletedAt; later reads and writes are 404', async () => {
      const contact = await createContact(prisma, owned(orgA, report));
      await http().delete(`${API}/${contact.id}`).set(as(reportT)).expect(204);
      expect((await row(contact.id)).deletedAt).not.toBeNull();
      await http().get(`${API}/${contact.id}`).set(as(reportT)).expect(404);
      await patch(reportT, contact.id, { firstName: 'X' }).expect(404);
      await http().delete(`${API}/${contact.id}`).set(as(reportT)).expect(404);
    });

    it('404 for a contact the caller cannot see, which stays untouched', async () => {
      const theirs = await createContact(prisma, owned(orgA, repX));
      await http().delete(`${API}/${theirs.id}`).set(as(reportT)).expect(404);
      expect((await row(theirs.id)).deletedAt).toBeNull();
    });

    it('a manager deletes a report contact; deleting the last contact frees the company to be deleted', async () => {
      const company = await createCompany(prisma, owned(orgA, report));
      const contact = await createContact(prisma, owned(orgA, report), { companyId: company.id });
      await http().delete(`${COMPANIES_API}/${company.id}`).set(as(reportT)).expect(409);
      await http().delete(`${API}/${contact.id}`).set(as(managerT)).expect(204);
      await http().delete(`${COMPANIES_API}/${company.id}`).set(as(reportT)).expect(204);
    });
  });

  describe('tenant isolation', () => {
    it('organization B can never read, update, delete or list organization A contacts', async () => {
      const contact = await createContact(prisma, owned(orgA, report));
      await http().get(`${API}/${contact.id}`).set(as(repBT)).expect(404);
      await patch(repBT, contact.id, { firstName: 'Hacked' }).expect(404);
      await http().delete(`${API}/${contact.id}`).set(as(repBT)).expect(404);
      const list = await http().get(API).set(as(repBT)).expect(200);
      expect(list.body.data).toEqual([]);
      expect(list.body.meta.total).toBe(0);
      const stored = await row(contact.id);
      expect(stored.firstName).toBe('Contact');
      expect(stored.deletedAt).toBeNull();
    });

    it('an organization A admin cannot touch organization B contacts', async () => {
      const contact = await createContact(prisma, owned(orgB, repB));
      await http().get(`${API}/${contact.id}`).set(as(adminT)).expect(404);
      await patch(adminT, contact.id, { firstName: 'Hacked' }).expect(404);
      await http().delete(`${API}/${contact.id}`).set(as(adminT)).expect(404);
      const list = await http().get(API).set(as(adminT)).expect(200);
      expect(list.body.data).toEqual([]);
    });

    it('cannot link to a company, or hand a contact to a user, of another organization', async () => {
      const foreignCompany = await createCompany(prisma, owned(orgB, repB));
      const contact = await createContact(prisma, owned(orgA, report));
      expect(
        (await patch(adminT, contact.id, { companyId: foreignCompany.id }).expect(400)).body.code,
      ).toBe('INVALID_COMPANY');
      expect((await patch(adminT, contact.id, { ownerId: repB.id }).expect(400)).body.code).toBe(
        'INVALID_OWNER',
      );
    });

    it('?companyId of another organization yields an empty list', async () => {
      const foreignCompany = await createCompany(prisma, owned(orgB, repB));
      await createContact(prisma, owned(orgB, repB), { companyId: foreignCompany.id });
      const res = await http()
        .get(`${API}?companyId=${foreignCompany.id}`)
        .set(as(adminT))
        .expect(200);
      expect(res.body.data).toEqual([]);
    });
  });

  // The invariant (not who wins): a live contact never points at a deleted company. Linking and
  // deleting race for the same 'company' advisory lock; whichever goes first, the other must see it.
  describe('linking races with deleting the company', () => {
    const liveContactsOfDeletedCompanies = async (): Promise<number> =>
      prisma.contact.count({ where: { deletedAt: null, company: { deletedAt: { not: null } } } });

    it('create + delete in parallel never leaves a live contact on a deleted company', async () => {
      for (let i = 0; i < RACE_ITERATIONS; i += 1) {
        const company = await createCompany(prisma, owned(orgA, report), { name: `Race ${i}` });
        const [created, deleted] = await Promise.all([
          post(reportT, { firstName: 'R', lastName: `${i}`, companyId: company.id }),
          http().delete(`${COMPANIES_API}/${company.id}`).set(as(reportT)),
        ]);
        expect([201, 400]).toContain(created.status);
        expect([204, 409]).toContain(deleted.status);
        expect(await liveContactsOfDeletedCompanies()).toBe(0);
      }
    });

    it('update-link + delete in parallel never leaves a live contact on a deleted company', async () => {
      for (let i = 0; i < RACE_ITERATIONS; i += 1) {
        const company = await createCompany(prisma, owned(orgA, report), { name: `Race ${i}` });
        const contact = await createContact(prisma, owned(orgA, report));
        const [linked, deleted] = await Promise.all([
          patch(reportT, contact.id, { companyId: company.id }),
          http().delete(`${COMPANIES_API}/${company.id}`).set(as(reportT)),
        ]);
        expect([200, 400]).toContain(linked.status);
        expect([204, 409]).toContain(deleted.status);
        expect(await liveContactsOfDeletedCompanies()).toBe(0);
      }
    });
  });
});
