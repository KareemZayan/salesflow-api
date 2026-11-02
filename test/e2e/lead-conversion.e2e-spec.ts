import { INestApplication } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import request from 'supertest';
import type { PrismaClient } from '../../prisma/seed/prisma-client';
import { ROLE_NAMES } from '../../prisma/seed/permissions';
import { acquireLock, type LockKind } from '../../src/infrastructure/prisma/advisory-lock';
import { createCompany, createContact, createLead } from '../factories/crm.factory';
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
// A score no scoring rule would produce for this lead: conversion must leave it exactly as is.
const SENTINEL_SCORE = 73;

interface Tokens {
  accessToken: string;
}

describe('Lead conversion (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let events: EventEmitter2;
  let orgA: TestOrganization;
  let orgB: TestOrganization;
  let manager: TestUser;
  let report: TestUser;
  let repX: TestUser; // outside the manager's team
  let nobody: TestUser; // authenticated, holds no permission
  let convertOnly: TestUser; // leads:convert alone
  let convertAndContact: TestUser; // leads:convert + contacts:create
  let repB: TestUser;

  let adminT: Tokens;
  let managerT: Tokens;
  let reportT: Tokens;
  let repXT: Tokens;
  let convertOnlyT: Tokens;
  let convertAndContactT: Tokens;
  let repBT: Tokens;

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
  const qualified = (
    user: Pick<TestUser, 'id'>,
    overrides: Parameters<typeof createLead>[2] = {},
    org: TestOrganization = orgA,
  ) =>
    createLead(prisma, owned(org, user), {
      status: 'QUALIFIED',
      score: SENTINEL_SCORE,
      email: 'omar@globex.com',
      phone: '+20 100 123 4567',
      companyName: 'Globex',
      ...overrides,
    });
  const leadRow = (id: string) => prisma.lead.findUniqueOrThrow({ where: { id } });
  const contactCount = () => prisma.contact.count();
  const companyCount = () => prisma.company.count();

  // Holds an advisory lock in an open transaction until `release()`, like a request in flight would.
  async function holdLock(kind: LockKind, id: string) {
    let release!: () => void;
    let acquired!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const held = new Promise<void>((resolve) => (acquired = resolve));
    const holder = prisma.$transaction(
      async (tx) => {
        await acquireLock(tx, kind, id);
        acquired();
        await gate;
      },
      { timeout: 30_000 },
    );
    await held;
    return { release: () => release(), done: holder };
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
    const noPermissions = await createCustomRole(prisma, orgA, 'Nobody', []);
    nobody = await createUser(prisma, orgA, { role: noPermissions.name });
    const onlyConvert = await createCustomRole(prisma, orgA, 'Convert only', ['leads:convert']);
    convertOnly = await createUser(prisma, orgA, { role: onlyConvert.name });
    const convertContact = await createCustomRole(prisma, orgA, 'Convert + contact', [
      'leads:convert',
      'contacts:create',
    ]);
    convertAndContact = await createUser(prisma, orgA, { role: convertContact.name });
    repB = await createUser(prisma, orgB);
    [adminT, managerT, reportT, repXT, convertOnlyT, convertAndContactT, repBT] = await Promise.all(
      [orgA.admin, manager, report, repX, convertOnly, convertAndContact, repB].map(signIn),
    );
  });

  afterEach(() => {
    events.removeAllListeners('lead.converted');
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('authentication and permissions', () => {
    it('401 without a token', async () => {
      const lead = await qualified(report);
      await http().post(`${API}/${lead.id}/convert`).send({}).expect(401);
    });

    it('403 FORBIDDEN without leads:convert', async () => {
      const lead = await qualified(nobody);
      const res = await convert(await signIn(nobody), lead.id).expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
      expect((await leadRow(lead.id)).status).toBe('QUALIFIED');
    });

    it('403 when a contact would be created without contacts:create (nothing changes)', async () => {
      const lead = await qualified(convertOnly);
      const res = await convert(convertOnlyT, lead.id).expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
      expect((await leadRow(lead.id)).status).toBe('QUALIFIED');
      expect(await contactCount()).toBe(0);
    });

    it('403 when createCompany lacks companies:create, even with contacts:create', async () => {
      const lead = await qualified(convertAndContact);
      await convert(convertAndContactT, lead.id, { createCompany: true }).expect(403);
      expect((await leadRow(lead.id)).status).toBe('QUALIFIED');
      expect(await companyCount()).toBe(0);
    });

    it('linking an existing contact works with leads:convert alone', async () => {
      const lead = await qualified(convertOnly);
      const contact = await createContact(prisma, owned(orgA, convertOnly));
      const res = await convert(convertOnlyT, lead.id, { contactId: contact.id }).expect(200);
      expect(res.body.contact.id).toBe(contact.id);
      expect((await leadRow(lead.id)).convertedContactId).toBe(contact.id);
    });

    it('linking an existing company to a new contact needs only contacts:create', async () => {
      const lead = await qualified(convertAndContact);
      const company = await createCompany(prisma, owned(orgA, convertAndContact));
      const res = await convert(convertAndContactT, lead.id, { companyId: company.id }).expect(200);
      expect(res.body.contact.companyId).toBe(company.id);
    });
  });

  describe('happy paths', () => {
    it('200: creates a contact from the lead, marks it CONVERTED, keeps the score, exact shape', async () => {
      const lead = await qualified(report);
      const res = await convert(reportT, lead.id).expect(200);

      expect(Object.keys(res.body).sort()).toEqual(['contact', 'createdCompany', 'lead']);
      expect(res.body.createdCompany).toBeNull();
      expect(res.body.contact).toMatchObject({
        firstName: lead.firstName,
        lastName: lead.lastName,
        email: 'omar@globex.com',
        phone: '+20 100 123 4567',
        companyId: null,
        ownerId: report.id,
      });
      expect(res.body.lead).toMatchObject({
        id: lead.id,
        status: 'CONVERTED',
        score: SENTINEL_SCORE,
        ownerId: report.id,
        convertedContactId: res.body.contact.id,
        convertedDealId: null,
      });
      expect(res.body.lead.convertedAt).not.toBeNull();

      const row = await leadRow(lead.id);
      expect(row.status).toBe('CONVERTED');
      expect(row.score).toBe(SENTINEL_SCORE);
      expect(row.convertedContactId).toBe(res.body.contact.id);
      expect(await contactCount()).toBe(1);
      expect(await companyCount()).toBe(0);
    });

    it('the lead company name is plain text: without createCompany no company appears', async () => {
      const lead = await qualified(report);
      await convert(reportT, lead.id).expect(200);
      expect(await companyCount()).toBe(0);
    });

    it('createCompany makes a company named after the lead and puts the contact under it', async () => {
      const lead = await qualified(orgA.admin);
      const res = await convert(adminT, lead.id, { createCompany: true }).expect(200);
      expect(res.body.createdCompany).toMatchObject({ name: 'Globex', ownerId: orgA.admin.id });
      expect(res.body.contact.companyId).toBe(res.body.createdCompany.id);
      expect(await companyCount()).toBe(1);
    });

    it('companyId links the new contact to an existing company without creating one', async () => {
      const lead = await qualified(report);
      const company = await createCompany(prisma, owned(orgA, report));
      const res = await convert(reportT, lead.id, { companyId: company.id }).expect(200);
      expect(res.body.createdCompany).toBeNull();
      expect(res.body.contact.companyId).toBe(company.id);
      expect(await companyCount()).toBe(1);
    });

    it('contactId links an existing contact and never modifies it', async () => {
      const lead = await qualified(report, { email: 'lead@other.com', companyName: 'Other Co' });
      const contact = await createContact(prisma, owned(orgA, report), {
        firstName: 'Existing',
        email: 'existing@acme.com',
      });
      const before = await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } });

      const res = await convert(reportT, lead.id, { contactId: contact.id }).expect(200);

      expect(res.body.contact.id).toBe(contact.id);
      expect(res.body.lead.convertedContactId).toBe(contact.id);
      expect(await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } })).toEqual(before);
      expect(await contactCount()).toBe(1);
      expect(await companyCount()).toBe(0);
    });

    it('several leads may link to the same contact', async () => {
      const contact = await createContact(prisma, owned(orgA, report));
      for (let i = 0; i < 2; i += 1) {
        const lead = await qualified(report);
        await convert(reportT, lead.id, { contactId: contact.id }).expect(200);
      }
      expect(await prisma.lead.count({ where: { convertedContactId: contact.id } })).toBe(2);
    });

    it('a manager converting a team member lead: the new records belong to the lead owner', async () => {
      const lead = await qualified(report);
      const res = await convert(managerT, lead.id, { createCompany: true }).expect(200);
      expect(res.body.contact.ownerId).toBe(report.id);
      expect(res.body.createdCompany.ownerId).toBe(report.id);
      expect(res.body.lead.ownerId).toBe(report.id);
    });

    it('duplicates are allowed: converting two leads with the same email makes two contacts', async () => {
      for (let i = 0; i < 2; i += 1) {
        const lead = await qualified(report);
        await convert(reportT, lead.id).expect(200);
      }
      expect(await prisma.contact.count({ where: { email: 'omar@globex.com' } })).toBe(2);
    });

    it('a converted lead stays final: PATCH, DELETE and status all answer 409', async () => {
      const lead = await qualified(report);
      await convert(reportT, lead.id).expect(200);
      const patched = await http()
        .patch(`${API}/${lead.id}`)
        .set(as(reportT))
        .send({ notes: 'x' })
        .expect(409);
      expect(patched.body.code).toBe('LEAD_ALREADY_CONVERTED');
      await http().delete(`${API}/${lead.id}`).set(as(reportT)).expect(409);
      await http()
        .post(`${API}/${lead.id}/status`)
        .set(as(reportT))
        .send({ status: 'CONTACTED' })
        .expect(409);
    });
  });

  describe('validation (400)', () => {
    it.each([
      ['an unknown deal field (Deals come in Phase 10)', { deal: { title: 'x' } }],
      ['any other unknown field', { status: 'CONVERTED' }],
      ['a non-uuid contactId', { contactId: 'nope' }],
      ['a null contactId', { contactId: null }],
      ['a non-boolean createCompany', { createCompany: 'yes' }],
    ])('rejects %s and changes nothing', async (_name, body) => {
      const lead = await qualified(report);
      const res = await convert(reportT, lead.id, body).expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect((await leadRow(lead.id)).status).toBe('QUALIFIED');
    });

    it('rejects a non-uuid id in the path', async () => {
      await convert(reportT, 'not-a-uuid').expect(400);
    });

    it.each([
      ['contactId + companyId', (c: string, co: string) => ({ contactId: c, companyId: co })],
      ['contactId + createCompany', (c: string) => ({ contactId: c, createCompany: true })],
      [
        'companyId + createCompany',
        (_c: string, co: string) => ({ companyId: co, createCompany: true }),
      ],
    ])('400 INVALID_CONVERSION_OPTIONS for %s (the body does not "win")', async (_name, body) => {
      const lead = await qualified(report);
      const contact = await createContact(prisma, owned(orgA, report));
      const company = await createCompany(prisma, owned(orgA, report));
      const res = await convert(reportT, lead.id, body(contact.id, company.id)).expect(400);
      expect(res.body.code).toBe('INVALID_CONVERSION_OPTIONS');
      expect((await leadRow(lead.id)).status).toBe('QUALIFIED');
    });

    it('400 for createCompany on a lead without a company name; everything rolls back', async () => {
      const lead = await qualified(report, { companyName: undefined });
      const res = await convert(reportT, lead.id, { createCompany: true }).expect(400);
      expect(res.body.code).toBe('INVALID_CONVERSION_OPTIONS');
      const row = await leadRow(lead.id);
      expect(row.status).toBe('QUALIFIED');
      expect(row.convertedAt).toBeNull();
      expect(await contactCount()).toBe(0);
      expect(await companyCount()).toBe(0);
    });
  });

  describe('lead state', () => {
    it.each(['NEW', 'CONTACTED', 'UNQUALIFIED'] as const)(
      '409 INVALID_STATUS_TRANSITION for a %s lead',
      async (status) => {
        const lead = await qualified(report, { status });
        const res = await convert(reportT, lead.id).expect(409);
        expect(res.body.code).toBe('INVALID_STATUS_TRANSITION');
        expect(await contactCount()).toBe(0);
      },
    );

    it('409 LEAD_ALREADY_CONVERTED when converting twice; only one contact exists', async () => {
      const lead = await qualified(report);
      await convert(reportT, lead.id).expect(200);
      const again = await convert(reportT, lead.id).expect(409);
      expect(again.body.code).toBe('LEAD_ALREADY_CONVERTED');
      expect(await contactCount()).toBe(1);
    });

    it('404 for a missing lead and for a soft-deleted one', async () => {
      await convert(reportT, MISSING_ID).expect(404);
      const deleted = await qualified(report, { deletedAt: new Date() });
      await convert(reportT, deleted.id).expect(404);
    });
  });

  describe('visibility and tenant isolation', () => {
    it('404 for a lead the caller may not see; nothing changes', async () => {
      const lead = await qualified(report);
      expect((await convert(repXT, lead.id).expect(404)).body.code).toBe('RESOURCE_NOT_FOUND');
      expect((await leadRow(lead.id)).status).toBe('QUALIFIED');
    });

    it('404 for another organization lead, in both directions', async () => {
      const leadA = await qualified(report);
      const leadB = await qualified(repB, {}, orgB);
      await convert(repBT, leadA.id).expect(404);
      await convert(reportT, leadB.id).expect(404);
      expect((await leadRow(leadA.id)).status).toBe('QUALIFIED');
      expect((await leadRow(leadB.id)).status).toBe('QUALIFIED');
    });

    it('400 INVALID_CONTACT for a contact of another organization, a hidden one or a deleted one', async () => {
      const foreign = await createContact(prisma, owned(orgB, repB));
      const hidden = await createContact(prisma, owned(orgA, repX));
      const deleted = await createContact(prisma, owned(orgA, report), { deletedAt: new Date() });
      for (const contactId of [foreign.id, hidden.id, deleted.id, MISSING_ID]) {
        const lead = await qualified(report);
        const res = await convert(reportT, lead.id, { contactId }).expect(400);
        expect(res.body.code).toBe('INVALID_CONTACT');
        expect((await leadRow(lead.id)).status).toBe('QUALIFIED');
      }
    });

    it('400 INVALID_COMPANY for a company of another organization, a hidden one or a deleted one; no contact is left behind', async () => {
      const foreign = await createCompany(prisma, owned(orgB, repB));
      const hidden = await createCompany(prisma, owned(orgA, repX));
      const deleted = await createCompany(prisma, owned(orgA, report), { deletedAt: new Date() });
      for (const companyId of [foreign.id, hidden.id, deleted.id, MISSING_ID]) {
        const lead = await qualified(report);
        const res = await convert(reportT, lead.id, { companyId }).expect(400);
        expect(res.body.code).toBe('INVALID_COMPANY');
        const row = await leadRow(lead.id);
        expect(row.status).toBe('QUALIFIED');
        expect(row.convertedAt).toBeNull();
      }
      expect(await contactCount()).toBe(0);
    });

    it('400 INVALID_OWNER when the lead owner was deactivated (reassign the lead first); nothing changes', async () => {
      const leaving = await createUser(prisma, orgA, { managerId: manager.id });
      const lead = await qualified(leaving);
      await prisma.user.update({ where: { id: leaving.id }, data: { isActive: false } });
      const res = await convert(managerT, lead.id).expect(400);
      expect(res.body.code).toBe('INVALID_OWNER');
      expect((await leadRow(lead.id)).status).toBe('QUALIFIED');
      expect(await contactCount()).toBe(0);
    });
  });

  describe('lead.converted event', () => {
    it('is emitted once after the commit with ids and the tenant only', async () => {
      const received: Record<string, unknown>[] = [];
      events.on('lead.converted', (payload: Record<string, unknown>) => {
        received.push(payload);
      });
      const lead = await qualified(report);
      const res = await convert(reportT, lead.id, { createCompany: true }).expect(200);

      await vi.waitFor(() => expect(received).toHaveLength(1));
      const [payload] = received;
      expect(Object.keys(payload ?? {}).sort()).toEqual([
        'actorId',
        'companyId',
        'contactId',
        'convertedAt',
        'dealId',
        'leadId',
        'organizationId',
        'ownerId',
      ]);
      expect(payload).toMatchObject({
        organizationId: orgA.id,
        leadId: lead.id,
        contactId: res.body.contact.id,
        companyId: res.body.createdCompany.id,
        dealId: null,
        ownerId: report.id,
        actorId: report.id,
      });
      expect(JSON.stringify(payload)).not.toMatch(/Omar|globex|\+20/i);
    });

    it('a listener that throws synchronously does not break the response', async () => {
      events.on('lead.converted', () => {
        throw new Error('sync listener failed');
      });
      const lead = await qualified(report);
      const res = await convert(reportT, lead.id).expect(200);
      expect(res.body.lead.status).toBe('CONVERTED');
    });

    it('a listener that rejects does not break the response', async () => {
      events.on('lead.converted', () => Promise.reject(new Error('async listener failed')));
      const lead = await qualified(report);
      const res = await convert(reportT, lead.id).expect(200);
      expect(res.body.lead.status).toBe('CONVERTED');
    });

    it('is not emitted when the conversion is rejected or rolled back', async () => {
      const received: unknown[] = [];
      events.on('lead.converted', (payload: unknown) => {
        received.push(payload);
      });
      const lead = await qualified(report);
      const deleted = await createCompany(prisma, owned(orgA, report), { deletedAt: new Date() });
      await convert(reportT, lead.id, { companyId: deleted.id }).expect(400); // rolled back
      await convert(repXT, lead.id).expect(404);
      const notQualified = await qualified(report, { status: 'NEW' });
      await convert(reportT, notQualified.id).expect(409);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(received).toEqual([]);
    });
  });

  // The invariants, whoever wins. Lock behaviour itself is pinned by the deterministic tests below.
  describe('races', () => {
    it('two parallel conversions of one lead: exactly one wins and one contact exists', async () => {
      for (let i = 0; i < RACE_ITERATIONS; i += 1) {
        const before = await contactCount();
        const lead = await qualified(report);
        const results = await Promise.all([
          convert(reportT, lead.id),
          convert(reportT, lead.id),
          convert(managerT, lead.id),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
        expect(await contactCount()).toBe(before + 1);
      }
    });

    it('conversion vs. a status change in parallel never leaves a half state', async () => {
      for (let i = 0; i < RACE_ITERATIONS; i += 1) {
        const before = await contactCount();
        const lead = await qualified(report);
        const [converted, moved] = await Promise.all([
          convert(reportT, lead.id),
          http().post(`${API}/${lead.id}/status`).set(as(reportT)).send({ status: 'UNQUALIFIED' }),
        ]);
        const row = await leadRow(lead.id);
        if (converted.status === 200) {
          expect(moved.status).toBe(409);
          expect(row.status).toBe('CONVERTED');
          expect(await contactCount()).toBe(before + 1);
        } else {
          expect(converted.status).toBe(409);
          expect(moved.status).toBe(200);
          expect(row.status).toBe('UNQUALIFIED');
          expect(row.convertedContactId).toBeNull();
          expect(await contactCount()).toBe(before);
        }
      }
    });

    it('conversion vs. an owner transfer in parallel: the lead is final and the contact belongs to the owner at claim time', async () => {
      for (let i = 0; i < RACE_ITERATIONS; i += 1) {
        const lead = await qualified(report);
        const [converted, transferred] = await Promise.all([
          convert(adminT, lead.id),
          http().patch(`${API}/${lead.id}`).set(as(adminT)).send({ ownerId: repX.id }),
        ]);
        expect(converted.status).toBe(200);
        expect([200, 409]).toContain(transferred.status);
        const row = await leadRow(lead.id);
        const contact = await prisma.contact.findUniqueOrThrow({
          where: { id: row.convertedContactId ?? MISSING_ID },
        });
        expect(contact.ownerId).toBe(row.ownerId);
        expect(row.ownerId).toBe(transferred.status === 200 ? repX.id : report.id);
      }
    });

    it('conversion into a company vs. deleting that company never leaves a live contact on a deleted company', async () => {
      for (let i = 0; i < RACE_ITERATIONS; i += 1) {
        const lead = await qualified(report);
        const company = await createCompany(prisma, owned(orgA, report), { name: `Race ${i}` });
        const [converted, deleted] = await Promise.all([
          convert(reportT, lead.id, { companyId: company.id }),
          http().delete(`/api/v1/companies/${company.id}`).set(as(reportT)),
        ]);
        expect([200, 400]).toContain(converted.status);
        expect([204, 409]).toContain(deleted.status);
        expect(
          await prisma.contact.count({
            where: { deletedAt: null, company: { deletedAt: { not: null } } },
          }),
        ).toBe(0);
      }
    });

    it('conversion with contactId vs. deleting that contact: whichever runs second sees the first', async () => {
      for (let i = 0; i < RACE_ITERATIONS; i += 1) {
        const lead = await qualified(report);
        const contact = await createContact(prisma, owned(orgA, report));
        const [converted, deleted] = await Promise.all([
          convert(reportT, lead.id, { contactId: contact.id }),
          http().delete(`/api/v1/contacts/${contact.id}`).set(as(reportT)),
        ]);
        expect(deleted.status).toBe(204);
        expect([200, 400]).toContain(converted.status);
        const row = await leadRow(lead.id);
        if (converted.status === 400) {
          expect(converted.body.code).toBe('INVALID_CONTACT');
          expect(row.status).toBe('QUALIFIED');
          expect(row.convertedContactId).toBeNull();
        } else {
          expect(row.convertedContactId).toBe(contact.id);
        }
      }
    });
  });

  // Deterministic proof of the locks (the loops above only show the invariant). Each test fails if
  // the lock it describes is removed from the code.
  describe('locks', () => {
    it('contactId: conversion waits for the contact lock, then sees a contact deleted meanwhile (INVALID_CONTACT)', async () => {
      const lead = await qualified(report);
      const contact = await createContact(prisma, owned(orgA, report));
      const holder = await holdLock('contact', contact.id);

      const pending = Promise.resolve(convert(reportT, lead.id, { contactId: contact.id }));
      expect(await stillPendingAfter(pending)).toBe(true);

      await prisma.contact.update({ where: { id: contact.id }, data: { deletedAt: new Date() } });
      holder.release();
      await holder.done;

      const res = await pending;
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_CONTACT');
      expect((await leadRow(lead.id)).status).toBe('QUALIFIED');
    });

    it('deleting a contact waits for a conversion that holds the contact lock', async () => {
      const contact = await createContact(prisma, owned(orgA, report));
      const holder = await holdLock('contact', contact.id);

      const pending = Promise.resolve(
        http().delete(`/api/v1/contacts/${contact.id}`).set(as(reportT)),
      );
      expect(await stillPendingAfter(pending)).toBe(true);

      holder.release();
      await holder.done;
      expect((await pending).status).toBe(204);
    });

    it('companyId: conversion waits for the company lock', async () => {
      const lead = await qualified(report);
      const company = await createCompany(prisma, owned(orgA, report));
      const holder = await holdLock('company', company.id);

      const pending = Promise.resolve(convert(reportT, lead.id, { companyId: company.id }));
      expect(await stillPendingAfter(pending)).toBe(true);

      holder.release();
      await holder.done;
      expect((await pending).status).toBe(200);
    });

    it('conversion waits for the lead lock', async () => {
      const lead = await qualified(report);
      const holder = await holdLock('lead', lead.id);

      const pending = Promise.resolve(convert(reportT, lead.id));
      expect(await stillPendingAfter(pending)).toBe(true);

      holder.release();
      await holder.done;
      expect((await pending).status).toBe(200);
    });
  });
});
