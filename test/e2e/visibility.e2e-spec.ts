import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '../../prisma/seed/prisma-client';
import { ROLE_NAMES } from '../../prisma/seed/permissions';
import { createTestPrisma, resetDatabase } from '../factories/database';
import {
  createCustomRole,
  createOrganization,
  createUser,
  type TestOrganization,
  type TestUser,
} from '../factories/organization.factory';
import { createTestApp } from '../setup/create-test-app';

const API = '/api/v1/__probe';

interface Tokens {
  accessToken: string;
}

describe('Ownership visibility (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let orgA: TestOrganization;
  let orgB: TestOrganization;
  let manager: TestUser;
  let report: TestUser;
  let inactiveReport: TestUser;
  let loner: TestUser;
  let support: TestUser; // custom role that has a report of its own
  let supportReport: TestUser;
  let managerB: TestUser;
  let reportB: TestUser;

  const http = () => request(app.getHttpServer());
  const signIn = async ({ email, password }: TestUser): Promise<Tokens> =>
    (await http().post('/api/v1/auth/login').send({ email, password }).expect(200)).body;
  const as = (tokens: Tokens) => ({ Authorization: `Bearer ${tokens.accessToken}` });
  // Sign in first: a supertest request binds to its server when it is created.
  const scopeOf = async (user: TestUser) => {
    const tokens = await signIn(user);
    return (await http().get(`${API}/visibility`).set(as(tokens)).expect(200)).body;
  };
  const owners = (body: { scope: { ownerIds: string[] } }) => [...body.scope.ownerIds].sort();

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
    loner = await createUser(prisma, orgA);
    const role = await createCustomRole(prisma, orgA, 'Support', []);
    support = await createUser(prisma, orgA, { role: role.name });
    supportReport = await createUser(prisma, orgA, { managerId: support.id });
    managerB = await createUser(prisma, orgB, { role: ROLE_NAMES.SALES_MANAGER });
    reportB = await createUser(prisma, orgB, { managerId: managerB.id });
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('ADMIN sees everything in the organization', async () => {
    const body = await scopeOf(orgA.admin);
    expect(body.scope).toEqual({ kind: 'all' });
    expect(body.where).toEqual({ AND: [{ status: 'NEW' }, {}] });
  });

  it('SALES_MANAGER sees self and direct reports, inactive ones included', async () => {
    const body = await scopeOf(manager);
    expect(owners(body)).toEqual([manager.id, report.id, inactiveReport.id].sort());
    expect(body.where).toEqual({
      AND: [{ status: 'NEW' }, { ownerId: { in: body.scope.ownerIds } }],
    });
  });

  it('SALES_REP sees only their own records', async () => {
    expect(owners(await scopeOf(report))).toEqual([report.id]);
    expect(owners(await scopeOf(loner))).toEqual([loner.id]);
  });

  it('a custom role fails closed to own-only, even with reports of its own', async () => {
    expect(owners(await scopeOf(support))).toEqual([support.id]);
    expect(supportReport.id).not.toBe(support.id);
  });

  it("another organization's team is never included", async () => {
    expect(owners(await scopeOf(managerB))).toEqual([managerB.id, reportB.id].sort());
    const a = owners(await scopeOf(manager));
    expect(a).not.toContain(managerB.id);
    expect(a).not.toContain(reportB.id);
  });

  it('a team change applies on the very next request (nothing is cached across requests)', async () => {
    const tokens = await signIn(manager);
    const before = await http().get(`${API}/visibility`).set(as(tokens)).expect(200);
    expect(owners(before.body)).not.toContain(loner.id);

    await prisma.user.update({ where: { id: loner.id }, data: { managerId: manager.id } });

    const after = await http().get(`${API}/visibility`).set(as(tokens)).expect(200);
    expect(owners(after.body)).toContain(loner.id);
  });

  it('single-record access: visible owners pass, everything else is a 404', async () => {
    const tokens = await signIn(manager);
    await http().get(`${API}/visible/${report.id}`).set(as(tokens)).expect(200);
    await http().get(`${API}/visible/${manager.id}`).set(as(tokens)).expect(200);

    for (const hidden of [loner.id, reportB.id, 'none']) {
      const res = await http().get(`${API}/visible/${hidden}`).set(as(tokens)).expect(404);
      expect(res.body.code).toBe('RESOURCE_NOT_FOUND');
    }
  });

  it('records without an owner are visible to admins only', async () => {
    const adminTokens = await signIn(orgA.admin);
    await http().get(`${API}/visible/none`).set(as(adminTokens)).expect(200);
    const managerTokens = await signIn(manager);
    await http().get(`${API}/visible/none`).set(as(managerTokens)).expect(404);
  });
});
