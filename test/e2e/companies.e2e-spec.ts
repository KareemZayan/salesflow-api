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

const API = '/api/v1/companies';

interface Tokens {
  accessToken: string;
}

describe('Companies (e2e)', () => {
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

  const http = () => request(app.getHttpServer());
  const signIn = async ({ email, password }: Pick<TestUser, 'email' | 'password'>) =>
    (await http().post('/api/v1/auth/login').send({ email, password }).expect(200)).body as Tokens;
  const as = (tokens: Tokens) => ({ Authorization: `Bearer ${tokens.accessToken}` });
  const owned = (org: TestOrganization, user: Pick<TestUser, 'id'>) => ({
    organizationId: org.id,
    ownerId: user.id,
  });
  const row = (id: string) => prisma.company.findUniqueOrThrow({ where: { id } });
  const names = (res: request.Response): string[] =>
    (res.body.data as { name: string }[]).map(({ name }) => name).sort();

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
    [adminT, managerT, reportT, repXT] = await Promise.all(
      [orgA.admin, manager, report, repX].map(signIn),
    );
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('authentication and permissions', () => {
    it('401 without a token, on every route', async () => {
      const company = await createCompany(prisma, owned(orgA, report));
      await http().get(API).expect(401);
      await http().get(`${API}/${company.id}`).expect(401);
      await http().post(API).send({ name: 'X' }).expect(401);
      await http().patch(`${API}/${company.id}`).send({ name: 'X' }).expect(401);
      await http().delete(`${API}/${company.id}`).expect(401);
    });

    it('403 FORBIDDEN without the matching permission, on every route', async () => {
      const t = await signIn(nobody);
      const company = await createCompany(prisma, owned(orgA, nobody));
      for (const res of [
        await http().get(API).set(as(t)),
        await http().get(`${API}/${company.id}`).set(as(t)),
        await http().post(API).set(as(t)).send({ name: 'X' }),
        await http().patch(`${API}/${company.id}`).set(as(t)).send({ name: 'X' }),
        await http().delete(`${API}/${company.id}`).set(as(t)),
      ]) {
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('FORBIDDEN');
      }
    });
  });

  describe('create', () => {
    it('201: the owner defaults to the caller and text is normalized', async () => {
      const res = await http()
        .post(API)
        .set(as(reportT))
        .send({
          name: '  Acme Ltd  ',
          domain: ' ACME.com ',
          industry: 'Software',
          phone: '+20 100 123 4567',
          address: '  1 Main St ',
        })
        .expect(201);
      expect(res.body).toMatchObject({
        name: 'Acme Ltd',
        domain: 'acme.com',
        industry: 'Software',
        phone: '+20 100 123 4567',
        address: '1 Main St',
        ownerId: report.id,
      });
      expect(Object.keys(res.body).sort()).toEqual(
        [
          'address',
          'createdAt',
          'domain',
          'id',
          'industry',
          'name',
          'ownerId',
          'phone',
          'updatedAt',
        ].sort(),
      );
      const stored = await row(res.body.id);
      expect(stored.organizationId).toBe(orgA.id);
    });

    it('allows duplicate names (the ERD has no uniqueness)', async () => {
      await http().post(API).set(as(reportT)).send({ name: 'Twin' }).expect(201);
      await http().post(API).set(as(reportT)).send({ name: 'Twin' }).expect(201);
    });

    it('400 VALIDATION_FAILED on bad input', async () => {
      const bad: object[] = [
        {},
        { name: '   ' },
        { name: 'x'.repeat(201) },
        { name: 'A', domain: 'https://acme.com' },
        { name: 'A', domain: 'acme.com/about' },
        { name: 'A', domain: 'not a host' },
        { name: 'A', phone: 'call me' },
        { name: 'A', ownerId: 'not-a-uuid' },
        { name: 5 },
      ];
      for (const body of bad) {
        const res = await http().post(API).set(as(reportT)).send(body).expect(400);
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
        const res = await http()
          .post(API)
          .set(as(reportT))
          .send({ name: 'X', ...extra })
          .expect(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
      expect(await prisma.company.count()).toBe(0);
    });

    describe('owner assignment', () => {
      const create = (tokens: Tokens, ownerId: string) =>
        http().post(API).set(as(tokens)).send({ name: 'Assigned', ownerId });

      it('a rep may name only themselves', async () => {
        await create(reportT, report.id).expect(201);
        for (const target of [repX.id, manager.id, orgA.admin.id]) {
          const res = await create(reportT, target).expect(400);
          expect(res.body.code).toBe('INVALID_OWNER');
        }
      });

      it('a manager may name themselves or an ACTIVE report, nobody else', async () => {
        const ok = await create(managerT, report.id).expect(201);
        expect(ok.body.ownerId).toBe(report.id);
        for (const target of [inactiveReport.id, repX.id, orgA.admin.id]) {
          expect((await create(managerT, target).expect(400)).body.code).toBe('INVALID_OWNER');
        }
      });

      it('an admin may name any active user of the organization', async () => {
        const res = await create(adminT, repX.id).expect(201);
        expect(res.body.ownerId).toBe(repX.id);
        expect((await create(adminT, inactiveReport.id).expect(400)).body.code).toBe(
          'INVALID_OWNER',
        );
      });

      it('a user of another organization gets the very same answer as an inactive one', async () => {
        const foreign = await create(adminT, repB.id).expect(400);
        const inactive = await create(adminT, inactiveReport.id).expect(400);
        const unknown = await create(adminT, '11111111-1111-4111-8111-111111111111').expect(400);
        for (const res of [foreign, unknown]) {
          expect(res.body.code).toBe('INVALID_OWNER');
          expect(res.body.message).toBe(inactive.body.message);
        }
      });
    });
  });

  describe('list and visibility', () => {
    let cReport: { id: string; name: string };
    let cManager: { id: string; name: string };
    let cInactive: { id: string; name: string };
    let cRepX: { id: string; name: string };
    let cAdmin: { id: string; name: string };
    let cDeleted: { id: string; name: string };

    beforeEach(async () => {
      cReport = await createCompany(prisma, owned(orgA, report), { name: 'Report Co' });
      cManager = await createCompany(prisma, owned(orgA, manager), { name: 'Manager Co' });
      cInactive = await createCompany(prisma, owned(orgA, inactiveReport), { name: 'Inactive Co' });
      cRepX = await createCompany(prisma, owned(orgA, repX), { name: 'RepX Co' });
      cAdmin = await createCompany(prisma, owned(orgA, orgA.admin), { name: 'Admin Co' });
      cDeleted = await createCompany(prisma, owned(orgA, report), {
        name: 'Deleted Co',
        deletedAt: new Date(),
      });
      await createCompany(prisma, owned(orgB, repB), { name: 'Other Org Co' });
    });

    it('a rep sees only their own companies', async () => {
      expect(names(await http().get(API).set(as(reportT)).expect(200))).toEqual(['Report Co']);
      expect(names(await http().get(API).set(as(repXT)).expect(200))).toEqual(['RepX Co']);
    });

    it('a manager sees their own and the whole team, inactive reports included', async () => {
      expect(names(await http().get(API).set(as(managerT)).expect(200))).toEqual([
        'Inactive Co',
        'Manager Co',
        'Report Co',
      ]);
    });

    it('an admin sees the whole organization, never another one, never deleted rows', async () => {
      const res = await http().get(API).set(as(adminT)).expect(200);
      expect(names(res)).toEqual(
        ['Admin Co', 'Inactive Co', 'Manager Co', 'RepX Co', 'Report Co'].sort(),
      );
      expect(res.body.data.map((c: { id: string }) => c.id)).not.toContain(cDeleted.id);
    });

    it('the total never counts rows the caller cannot see', async () => {
      const rep = await http().get(`${API}?limit=1`).set(as(reportT)).expect(200);
      expect(rep.body.meta).toMatchObject({ total: 1, totalPages: 1, limit: 1, page: 1 });
      const mgr = await http().get(`${API}?limit=2`).set(as(managerT)).expect(200);
      expect(mgr.body.meta).toMatchObject({ total: 3, totalPages: 2 });
      const adm = await http().get(`${API}?limit=2`).set(as(adminT)).expect(200);
      expect(adm.body.meta.total).toBe(5);
    });

    it('?ownerId= of another user yields an empty page for a rep, not 403 and not data', async () => {
      const res = await http().get(`${API}?ownerId=${repX.id}`).set(as(reportT)).expect(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.meta.total).toBe(0);
      const foreign = await http().get(`${API}?ownerId=${repB.id}`).set(as(adminT)).expect(200);
      expect(foreign.body.data).toEqual([]);
    });

    it('?ownerId= narrows within what the caller may see', async () => {
      const mgr = await http().get(`${API}?ownerId=${report.id}`).set(as(managerT)).expect(200);
      expect(names(mgr)).toEqual(['Report Co']);
      const outsideTeam = await http()
        .get(`${API}?ownerId=${repX.id}`)
        .set(as(managerT))
        .expect(200);
      expect(outsideTeam.body.data).toEqual([]);
      const adm = await http().get(`${API}?ownerId=${repX.id}`).set(as(adminT)).expect(200);
      expect(names(adm)).toEqual(['RepX Co']);
    });

    it('q searches name, domain and industry, case-insensitively', async () => {
      await prisma.company.update({
        where: { id: cAdmin.id },
        data: { domain: 'globex.io', industry: 'Logistics' },
      });
      expect(names(await http().get(`${API}?q=ADMIN`).set(as(adminT)).expect(200))).toEqual([
        'Admin Co',
      ]);
      expect(names(await http().get(`${API}?q=globex`).set(as(adminT)).expect(200))).toEqual([
        'Admin Co',
      ]);
      expect(names(await http().get(`${API}?q=logist`).set(as(adminT)).expect(200))).toEqual([
        'Admin Co',
      ]);
    });

    it('q=% and q=_ match literally, not as wildcards', async () => {
      await createCompany(prisma, owned(orgA, orgA.admin), { name: '100% Pure' });
      await createCompany(prisma, owned(orgA, orgA.admin), { name: 'snake_case' });
      const pct = await http()
        .get(`${API}?q=${encodeURIComponent('%')}`)
        .set(as(adminT))
        .expect(200);
      expect(names(pct)).toEqual(['100% Pure']);
      const underscore = await http().get(`${API}?q=_`).set(as(adminT)).expect(200);
      expect(names(underscore)).toEqual(['snake_case']);
      const backslash = await http()
        .get(`${API}?q=${encodeURIComponent('\\')}`)
        .set(as(adminT))
        .expect(200);
      expect(backslash.body.data).toEqual([]);
    });

    it('a blank q is ignored; an over-long q is a 400', async () => {
      const blank = await http().get(`${API}?q=%20%20`).set(as(adminT)).expect(200);
      expect(blank.body.meta.total).toBe(5);
      const long = await http()
        .get(`${API}?q=${'a'.repeat(101)}`)
        .set(as(adminT))
        .expect(400);
      expect(long.body.code).toBe('VALIDATION_FAILED');
    });

    it('sorts by a whitelisted field and rejects anything else with 400', async () => {
      const asc = await http().get(`${API}?sortBy=name&sortOrder=asc`).set(as(adminT)).expect(200);
      expect(asc.body.data.map((c: { name: string }) => c.name)).toEqual([
        'Admin Co',
        'Inactive Co',
        'Manager Co',
        'RepX Co',
        'Report Co',
      ]);
      const bad = await http().get(`${API}?sortBy=passwordHash`).set(as(adminT)).expect(400);
      expect(bad.body.code).toBe('INVALID_SORT_FIELD');
    });

    it('visibility on single records: the same 404 for hidden, missing and foreign', async () => {
      await http().get(`${API}/${cReport.id}`).set(as(reportT)).expect(200);
      await http().get(`${API}/${cReport.id}`).set(as(managerT)).expect(200);
      await http().get(`${API}/${cManager.id}`).set(as(managerT)).expect(200);

      const hidden = await http().get(`${API}/${cRepX.id}`).set(as(reportT)).expect(404);
      const hiddenFromManager = await http()
        .get(`${API}/${cRepX.id}`)
        .set(as(managerT))
        .expect(404);
      const missing = await http()
        .get(`${API}/11111111-1111-4111-8111-111111111111`)
        .set(as(reportT))
        .expect(404);
      const deleted = await http().get(`${API}/${cDeleted.id}`).set(as(reportT)).expect(404);
      for (const res of [hiddenFromManager, missing, deleted]) {
        expect(res.body.code).toBe('RESOURCE_NOT_FOUND');
        expect(res.body.message).toBe(hidden.body.message);
      }
      await http().get(`${API}/${cInactive.id}`).set(as(managerT)).expect(200);
    });

    it('400 for a malformed id', async () => {
      await http().get(`${API}/not-a-uuid`).set(as(adminT)).expect(400);
    });
  });

  describe('update', () => {
    let company: { id: string };

    beforeEach(async () => {
      company = await createCompany(prisma, owned(orgA, report), {
        name: 'Before',
        domain: 'before.com',
        industry: 'Retail',
      });
    });
    const patch = (tokens: Tokens, id: string, body: object) =>
      http().patch(`${API}/${id}`).set(as(tokens)).send(body);

    it('200: edits own company, normalizing text', async () => {
      const res = await patch(reportT, company.id, { name: ' After ', domain: 'AFTER.io' }).expect(
        200,
      );
      expect(res.body).toMatchObject({ name: 'After', domain: 'after.io', industry: 'Retail' });
    });

    it('null or a blank string clears an optional field', async () => {
      const res = await patch(reportT, company.id, { domain: null, industry: '  ' }).expect(200);
      expect(res.body).toMatchObject({ domain: null, industry: null, name: 'Before' });
    });

    it('400 EMPTY_UPDATE for an empty body', async () => {
      const res = await patch(reportT, company.id, {}).expect(400);
      expect(res.body.code).toBe('EMPTY_UPDATE');
    });

    it('200 when the values repeat what is stored (only an EMPTY body is an error)', async () => {
      const res = await patch(reportT, company.id, { name: 'Before' }).expect(200);
      expect(res.body.name).toBe('Before');
    });

    it('400 for organizationId, deletedAt, createdAt in the body, and for a null name or owner', async () => {
      for (const body of [
        { organizationId: orgB.id },
        { deletedAt: null },
        { createdAt: '2020-01-01T00:00:00.000Z' },
        { name: null },
        { ownerId: null },
        { name: '   ' },
        { domain: 'http://x.com' },
      ]) {
        const res = await patch(reportT, company.id, body).expect(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
      const stored = await row(company.id);
      expect(stored.organizationId).toBe(orgA.id);
      expect(stored.deletedAt).toBeNull();
    });

    it("rep GET, PATCH and DELETE on another rep's company all return the same 404", async () => {
      const theirs = await createCompany(prisma, owned(orgA, repX), { name: 'Theirs' });
      const get = await http().get(`${API}/${theirs.id}`).set(as(reportT)).expect(404);
      const upd = await patch(reportT, theirs.id, { name: 'Hacked' }).expect(404);
      const del = await http().delete(`${API}/${theirs.id}`).set(as(reportT)).expect(404);
      for (const res of [upd, del]) {
        expect(res.body.code).toBe(get.body.code);
        expect(res.body.message).toBe(get.body.message);
      }
      const stored = await row(theirs.id);
      expect(stored.name).toBe('Theirs');
      expect(stored.deletedAt).toBeNull();
    });

    describe('ownership transfer', () => {
      it('a rep cannot transfer ownership (their scope is themselves only)', async () => {
        const res = await patch(reportT, company.id, { ownerId: repX.id }).expect(400);
        expect(res.body.code).toBe('INVALID_OWNER');
        expect((await row(company.id)).ownerId).toBe(report.id);
      });

      it('repeating the current owner is not a transfer', async () => {
        await patch(reportT, company.id, { ownerId: report.id, name: 'Same owner' }).expect(200);
      });

      it('a manager transfers within the team; outside it or to an inactive report is a 400', async () => {
        const ok = await patch(managerT, company.id, { ownerId: manager.id }).expect(200);
        expect(ok.body.ownerId).toBe(manager.id);
        for (const target of [repX.id, inactiveReport.id, repB.id]) {
          const res = await patch(managerT, company.id, { ownerId: target }).expect(400);
          expect(res.body.code).toBe('INVALID_OWNER');
        }
        expect((await row(company.id)).ownerId).toBe(manager.id);
      });

      it('an admin transfers to any active user; a foreign-organization owner is a 400', async () => {
        const ok = await patch(adminT, company.id, { ownerId: repX.id }).expect(200);
        expect(ok.body.ownerId).toBe(repX.id);
        const res = await patch(adminT, company.id, { ownerId: repB.id }).expect(400);
        expect(res.body.code).toBe('INVALID_OWNER');
      });

      it('a manager can edit a company owned by an inactive report without changing the owner', async () => {
        const orphan = await createCompany(prisma, owned(orgA, inactiveReport), { name: 'Old' });
        const plain = await patch(managerT, orphan.id, { name: 'Edited' }).expect(200);
        expect(plain.body.ownerId).toBe(inactiveReport.id);
        const sameOwner = await patch(managerT, orphan.id, {
          name: 'Edited again',
          ownerId: inactiveReport.id,
        }).expect(200);
        expect(sameOwner.body).toMatchObject({ name: 'Edited again', ownerId: inactiveReport.id });
      });

      it('after an admin reassigns, the former owner can no longer edit (404)', async () => {
        await patch(adminT, company.id, { ownerId: repX.id }).expect(200);
        const res = await patch(reportT, company.id, { name: 'Too late' }).expect(404);
        expect(res.body.code).toBe('RESOURCE_NOT_FOUND');
        expect((await row(company.id)).name).toBe('Before');
      });

      it('a rep edit racing an admin reassignment is applied if and only if it answered 200', async () => {
        for (let i = 0; i < 8; i++) {
          const raced = await createCompany(prisma, owned(orgA, report), { name: `Race ${i}` });
          const [edit] = await Promise.all([
            patch(reportT, raced.id, { name: `Edited ${i}` }),
            patch(adminT, raced.id, { ownerId: repX.id }),
          ]);
          expect([200, 404]).toContain(edit.status);
          const stored = await row(raced.id);
          expect(stored.ownerId).toBe(repX.id);
          expect(stored.name).toBe(edit.status === 200 ? `Edited ${i}` : `Race ${i}`);
        }
      });
    });
  });

  describe('delete', () => {
    const remove = (tokens: Tokens, id: string) => http().delete(`${API}/${id}`).set(as(tokens));

    it('204 soft-deletes: the row stays, every endpoint then answers 404', async () => {
      const company = await createCompany(prisma, owned(orgA, report));
      const res = await remove(reportT, company.id).expect(204);
      expect(res.text).toBe('');
      expect((await row(company.id)).deletedAt).not.toBeNull();

      await http().get(`${API}/${company.id}`).set(as(reportT)).expect(404);
      await http().patch(`${API}/${company.id}`).set(as(reportT)).send({ name: 'x' }).expect(404);
      const list = await http().get(API).set(as(reportT)).expect(200);
      expect(list.body.data).toEqual([]);
    });

    it('deleting an already-deleted company is a 404', async () => {
      const company = await createCompany(prisma, owned(orgA, report));
      await remove(reportT, company.id).expect(204);
      const again = await remove(reportT, company.id).expect(404);
      expect(again.body.code).toBe('RESOURCE_NOT_FOUND');
      await remove(adminT, company.id).expect(404);
    });

    it("a manager deletes a report's company; a rep cannot delete a colleague's", async () => {
      const company = await createCompany(prisma, owned(orgA, report));
      await remove(repXT, company.id).expect(404);
      await remove(managerT, company.id).expect(204);
    });

    it('409 COMPANY_HAS_CONTACTS while a live contact exists, whoever owns it', async () => {
      const company = await createCompany(prisma, owned(orgA, report));
      await createContact(prisma, owned(orgA, repX), { companyId: company.id });

      const res = await remove(reportT, company.id).expect(409);
      expect(res.body.code).toBe('COMPANY_HAS_CONTACTS');
      expect(res.body.message).toBe('Company has contacts and cannot be deleted');
      expect(JSON.stringify(res.body)).not.toContain(repX.id);
      expect((await row(company.id)).deletedAt).toBeNull();

      await remove(adminT, company.id).expect(409);
    });

    it('soft-deleted contacts do not block the delete', async () => {
      const company = await createCompany(prisma, owned(orgA, report));
      await createContact(prisma, owned(orgA, report), {
        companyId: company.id,
        deletedAt: new Date(),
      });
      await remove(reportT, company.id).expect(204);
    });

    it('the 409 is never shown for a company the caller cannot see (it is a 404)', async () => {
      const company = await createCompany(prisma, owned(orgA, repX));
      await createContact(prisma, owned(orgA, repX), { companyId: company.id });
      const res = await remove(reportT, company.id).expect(404);
      expect(res.body.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('contacts of another organization are not counted (they cannot be linked anyway)', async () => {
      const company = await createCompany(prisma, owned(orgA, report));
      await createContact(prisma, owned(orgB, repB));
      await remove(reportT, company.id).expect(204);
    });
  });

  describe('tenant isolation', () => {
    it('organization A can never read, update or delete organization B data, and vice versa', async () => {
      const theirs = await createCompany(prisma, owned(orgB, repB), { name: 'B only' });
      const mine = await createCompany(prisma, owned(orgA, report), { name: 'A only' });
      const bAdminT = await signIn(orgB.admin);

      for (const tokens of [adminT, managerT, reportT]) {
        await http().get(`${API}/${theirs.id}`).set(as(tokens)).expect(404);
        await http().patch(`${API}/${theirs.id}`).set(as(tokens)).send({ name: 'x' }).expect(404);
        await http().delete(`${API}/${theirs.id}`).set(as(tokens)).expect(404);
      }
      await http().get(`${API}/${mine.id}`).set(as(bAdminT)).expect(404);
      await http().patch(`${API}/${mine.id}`).set(as(bAdminT)).send({ name: 'x' }).expect(404);
      await http().delete(`${API}/${mine.id}`).set(as(bAdminT)).expect(404);

      expect(names(await http().get(API).set(as(adminT)).expect(200))).toEqual(['A only']);
      expect(names(await http().get(API).set(as(bAdminT)).expect(200))).toEqual(['B only']);
      expect((await row(theirs.id)).name).toBe('B only');
      expect((await row(theirs.id)).deletedAt).toBeNull();
      expect((await row(mine.id)).deletedAt).toBeNull();
    });

    it('a created company belongs to the caller organization whatever the client sends', async () => {
      const res = await http()
        .post(API)
        .set(as(adminT))
        .send({ name: 'Mine', organizationId: orgB.id })
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      const ok = await http().post(API).set(as(adminT)).send({ name: 'Mine' }).expect(201);
      expect((await row(ok.body.id)).organizationId).toBe(orgA.id);
    });
  });
});
