import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { Queue } from 'bullmq';
import request from 'supertest';
import type { PrismaClient } from '../../prisma/seed/prisma-client';
import { ROLE_NAMES } from '../../prisma/seed/permissions';
import { TenantContextService } from '../../src/common/tenant/tenant-context.service';
import { ActivityType } from '../../src/generated/prisma/client';
import { QUEUE_NAMES } from '../../src/infrastructure/queue/queue.constants';
import { ActivitiesService } from '../../src/modules/activities/activities.service';
import { CREATE_ACTIVITY_JOB, CreateActivityJob } from '../../src/modules/activities/activity-job';
import {
  createCompany,
  createContact,
  createDeal,
  createLead,
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
import { createTestApp, purgeTestQueues } from '../setup/create-test-app';
import { waitFor } from '../support/wait-for';

const API = '/api/v1';
const MISSING_ID = '11111111-1111-4111-8111-111111111111';

interface Tokens {
  accessToken: string;
}
interface Entry {
  id: string;
  type: string;
  subject: string;
  body: string | null;
  metadata: Record<string, unknown> | null;
  actorId: string | null;
  isManual: boolean;
  occurredAt: string;
}
interface Timeline {
  data: Entry[];
  meta: { limit: number; nextCursor: string | null };
}

// Real compose Redis, workers on: a status change travels event -> queue -> worker -> table.
describe('Activities (e2e, real Redis)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let queue: Queue;
  let orgA: TestOrganization;
  let orgB: TestOrganization;
  let manager: TestUser;
  let rep: TestUser; // reports to `manager`
  let other: TestUser; // another rep, not on the manager's team
  let repB: TestUser;
  let readOnly: TestUser; // activities:read + leads:read, no activities:create
  let adminT: Tokens;
  let managerT: Tokens;
  let repT: Tokens;
  let otherT: Tokens;
  let adminBT: Tokens;
  let readOnlyT: Tokens;
  let pipeline: Awaited<ReturnType<typeof findDefaultPipeline>>;

  const http = () => request(app.getHttpServer());
  const signIn = async ({ email, password }: Pick<TestUser, 'email' | 'password'>) =>
    (await http().post(`${API}/auth/login`).send({ email, password }).expect(200)).body as Tokens;
  const as = (tokens: Tokens) => ({ Authorization: `Bearer ${tokens.accessToken}` });
  const timeline = (tokens: Tokens, kind: string, id: string, query = '') =>
    http().get(`${API}/${kind}/${id}/activities${query}`).set(as(tokens));
  const note = (tokens: Tokens, kind: string, id: string, body: object) =>
    http().post(`${API}/${kind}/${id}/activities`).set(as(tokens)).send(body);
  const drained = async () =>
    waitFor(async () => {
      const counts = await queue.getJobCounts('waiting', 'active', 'delayed');
      return counts.waiting + counts.active + counts.delayed === 0;
    });
  const entriesOf = (where: object) => prisma.activity.findMany({ where });
  const asWorker = <T>(organizationId: string, fn: () => Promise<T>) =>
    app.get(TenantContextService).run(organizationId, fn);

  beforeAll(async () => {
    app = await createTestApp({ queue: { workers: true } });
    prisma = createTestPrisma();
    queue = app.get<Queue>(getQueueToken(QUEUE_NAMES.ACTIVITIES), { strict: false });
  });

  afterAll(async () => {
    await purgeTestQueues(app);
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
    await resetDatabase(prisma);
    orgA = await createOrganization(prisma, 'orga');
    orgB = await createOrganization(prisma, 'orgb');
    manager = await createUser(prisma, orgA, { role: ROLE_NAMES.SALES_MANAGER });
    rep = await createUser(prisma, orgA, { managerId: manager.id });
    other = await createUser(prisma, orgA);
    repB = await createUser(prisma, orgB);
    const role = await createCustomRole(prisma, orgA, 'reader', ['activities:read', 'leads:read']);
    readOnly = await createUser(prisma, orgA, { role: role.name });
    adminT = await signIn(orgA.admin);
    managerT = await signIn(manager);
    repT = await signIn(rep);
    otherT = await signIn(other);
    adminBT = await signIn(orgB.admin);
    readOnlyT = await signIn(readOnly);
    await signIn(repB);
    pipeline = await findDefaultPipeline(prisma, orgA.id);
  });

  const leadOf = (owner: TestUser, overrides: Parameters<typeof createLead>[2] = {}) =>
    createLead(prisma, { organizationId: orgA.id, ownerId: owner.id }, overrides);

  describe('manual entries', () => {
    it('logs a note, trims the text and lists it on the timeline', async () => {
      const lead = await leadOf(rep);
      const res = await note(repT, 'leads', lead.id, {
        type: 'CALL',
        subject: '  Intro call  ',
        body: '  Discussed pricing.  ',
      }).expect(201);
      expect(res.body).toMatchObject({
        type: 'CALL',
        subject: 'Intro call',
        body: 'Discussed pricing.',
        actorId: rep.id,
        isManual: true,
        leadId: lead.id,
      });

      const list = (await timeline(repT, 'leads', lead.id).expect(200)).body as Timeline;
      expect(list.data.map((e) => e.id)).toEqual([res.body.id]);
    });

    it('works on all four parents', async () => {
      const company = await createCompany(prisma, { organizationId: orgA.id, ownerId: rep.id });
      const contact = await createContact(prisma, { organizationId: orgA.id, ownerId: rep.id });
      const lead = await leadOf(rep);
      const deal = await createDeal(
        prisma,
        { organizationId: orgA.id, ownerId: rep.id },
        { pipelineId: pipeline.id, stageId: pipeline.stages[0].id },
      );
      for (const [kind, id] of [
        ['leads', lead.id],
        ['deals', deal.id],
        ['contacts', contact.id],
        ['companies', company.id],
      ]) {
        await note(repT, kind, id, { type: 'NOTE', subject: 'n' }).expect(201);
        expect(((await timeline(repT, kind, id).expect(200)).body as Timeline).data).toHaveLength(
          1,
        );
      }
    });

    it('a blank body means no body', async () => {
      const lead = await leadOf(rep);
      const res = await note(repT, 'leads', lead.id, { type: 'NOTE', subject: 's', body: '   ' });
      expect(res.status).toBe(201);
      expect(res.body.body).toBeNull();
    });

    it.each([
      ['a server-only type', { type: 'SYSTEM', subject: 's' }],
      ['STAGE_CHANGE', { type: 'STAGE_CHANGE', subject: 's' }],
      ['a blank subject', { type: 'NOTE', subject: '   ' }],
      ['a too long subject', { type: 'NOTE', subject: 'x'.repeat(201) }],
      ['a too long body', { type: 'NOTE', subject: 's', body: 'x'.repeat(5001) }],
      ['a null body', { type: 'NOTE', subject: 's', body: null }],
      ['an unknown field', { type: 'NOTE', subject: 's', occurredAt: '2020-01-01T00:00:00Z' }],
      ['a client-chosen actor', { type: 'NOTE', subject: 's', actorId: MISSING_ID }],
    ])('rejects %s with 400', async (_name, body) => {
      const lead = await leadOf(rep);
      await note(repT, 'leads', lead.id, body).expect(400);
      expect(await entriesOf({ leadId: lead.id })).toHaveLength(0);
    });

    it('403 without activities:create', async () => {
      const lead = await leadOf(readOnly);
      await note(readOnlyT, 'leads', lead.id, { type: 'NOTE', subject: 's' }).expect(403);
      await timeline(readOnlyT, 'leads', lead.id).expect(200);
    });

    it('401 without a token', async () => {
      await http().get(`${API}/leads/${MISSING_ID}/activities`).expect(401);
    });
  });

  describe('visibility of the parent', () => {
    it('a lead the caller cannot see is 404 for the timeline and for logging', async () => {
      const lead = await leadOf(rep);
      await timeline(otherT, 'leads', lead.id).expect(404);
      await note(otherT, 'leads', lead.id, { type: 'NOTE', subject: 's' }).expect(404);
      expect(await entriesOf({ leadId: lead.id })).toHaveLength(0);
    });

    it('a manager sees the timeline of a team member lead; an admin sees everything', async () => {
      const lead = await leadOf(rep);
      await timeline(managerT, 'leads', lead.id).expect(200);
      await timeline(adminT, 'leads', lead.id).expect(200);
    });

    it('a missing or soft-deleted parent is 404', async () => {
      const gone = await leadOf(rep, { deletedAt: new Date() });
      await timeline(repT, 'leads', MISSING_ID).expect(404);
      await timeline(repT, 'leads', gone.id).expect(404);
    });
  });

  describe('system entries through the queue', () => {
    it('a lead status change appears on the lead timeline with who, from and to', async () => {
      const lead = await leadOf(rep);
      await http()
        .post(`${API}/leads/${lead.id}/status`)
        .set(as(repT))
        .send({ status: 'CONTACTED' })
        .expect(200);

      const [entry] = await waitFor(async () => {
        const rows = (await timeline(repT, 'leads', lead.id).expect(200)).body as Timeline;
        return rows.data.length > 0 && rows.data;
      });
      expect(entry).toMatchObject({
        type: 'SYSTEM',
        subject: 'Lead status changed',
        actorId: rep.id,
        isManual: false,
        metadata: { kind: 'lead.status_changed', from: 'NEW', to: 'CONTACTED' },
      });
    });

    it('a rejected status change leaves no entry', async () => {
      const lead = await leadOf(rep);
      await http()
        .post(`${API}/leads/${lead.id}/status`)
        .set(as(repT))
        .send({ status: 'QUALIFIED' })
        .expect(409);
      await drained();
      expect(await entriesOf({ leadId: lead.id })).toHaveLength(0);
    });

    it('assigning a lead to someone else records the assignment', async () => {
      const res = await http()
        .post(`${API}/leads`)
        .set(as(adminT))
        .send({ firstName: 'A', lastName: 'B', source: 'WEBSITE', ownerId: rep.id })
        .expect(201);
      const [entry] = await waitFor(async () => {
        const rows = await entriesOf({ leadId: res.body.id });
        return rows.length > 0 && rows;
      });
      expect(entry.metadata).toMatchObject({ kind: 'lead.assigned', ownerId: rep.id });
    });

    it('a repeated job for the same fact and target writes one entry', async () => {
      const lead = await leadOf(rep);
      const job: CreateActivityJob = {
        organizationId: orgA.id,
        actorId: rep.id,
        type: ActivityType.SYSTEM,
        subject: 'Lead status changed',
        metadata: { kind: 'lead.status_changed', from: 'NEW', to: 'CONTACTED' },
        occurredAt: new Date().toISOString(),
        target: { kind: 'lead', id: lead.id },
        dedupeKey: `test-${lead.id}`,
      };
      await queue.add(CREATE_ACTIVITY_JOB, job, { jobId: 'first' });
      await queue.add(CREATE_ACTIVITY_JOB, job, { jobId: 'second' });
      await waitFor(async () => (await entriesOf({ leadId: lead.id })).length >= 1);
      await drained();
      expect(await entriesOf({ leadId: lead.id })).toHaveLength(1);
    });

    it('conversion writes one entry per target: lead, contact, company and deal', async () => {
      const lead = await leadOf(rep, { status: 'QUALIFIED', companyName: 'Acme' });
      const res = await http()
        .post(`${API}/leads/${lead.id}/convert`)
        .set(as(adminT))
        .send({ createCompany: true, deal: { title: 'Big deal' } })
        .expect(200);
      const {
        contact,
        createdCompany: company,
        deal,
      } = res.body as {
        contact: { id: string };
        createdCompany: { id: string };
        deal: { id: string };
      };

      const rows = await waitFor(async () => {
        const found = await prisma.activity.findMany({
          where: { metadata: { path: ['kind'], equals: 'lead.converted' } },
        });
        return found.length >= 4 && found;
      });
      await drained();
      expect(rows).toHaveLength(4);
      expect(rows.map((r) => r.leadId ?? r.contactId ?? r.companyId ?? r.dealId).sort()).toEqual(
        [lead.id, contact.id, company.id, deal.id].sort(),
      );
      expect(new Set(rows.map((r) => r.dedupeKey)).size).toBe(4);
      for (const row of rows) {
        const links = [row.leadId, row.contactId, row.companyId, row.dealId].filter(Boolean);
        expect(links).toHaveLength(1);
      }
    });

    it('a deal stage move lands on the deal, its contact and its company', async () => {
      const company = await createCompany(prisma, { organizationId: orgA.id, ownerId: rep.id });
      const contact = await createContact(prisma, { organizationId: orgA.id, ownerId: rep.id });
      const deal = await createDeal(
        prisma,
        { organizationId: orgA.id, ownerId: rep.id },
        { pipelineId: pipeline.id, stageId: pipeline.stages[0].id },
        { contactId: contact.id, companyId: company.id },
      );
      await http()
        .post(`${API}/deals/${deal.id}/move`)
        .set(as(repT))
        .send({ stageId: pipeline.stages[1].id })
        .expect(200);

      await waitFor(async () => (await prisma.activity.count()) >= 3);
      await drained();
      for (const [kind, id] of [
        ['deals', deal.id],
        ['contacts', contact.id],
        ['companies', company.id],
      ]) {
        const { data } = (await timeline(repT, kind, id).expect(200)).body as Timeline;
        expect(data).toHaveLength(1);
        expect(data[0]).toMatchObject({ type: 'STAGE_CHANGE', actorId: rep.id });
        expect(data[0].metadata).toMatchObject({
          deal: { dealId: deal.id, toStageId: pipeline.stages[1].id, status: 'OPEN' },
        });
      }
    });
  });

  describe('deal details on other timelines (privacy)', () => {
    it('a rep who sees the contact but not the deal gets no stage, amount, title or deal id', async () => {
      const contact = await createContact(prisma, { organizationId: orgA.id, ownerId: rep.id });
      // The deal belongs to ANOTHER rep: `rep` cannot see it, only the contact it is linked to.
      const deal = await createDeal(
        prisma,
        { organizationId: orgA.id, ownerId: other.id },
        { pipelineId: pipeline.id, stageId: pipeline.stages[0].id },
        { contactId: contact.id, title: 'Secret Renewal Q4', amount: '98765.43' },
      );
      await timeline(repT, 'deals', deal.id).expect(404);
      await http()
        .post(`${API}/deals/${deal.id}/move`)
        .set(as(otherT))
        .send({ stageId: pipeline.stages[1].id })
        .expect(200);
      await waitFor(async () => (await prisma.activity.count()) >= 2);
      await drained();

      const res = await timeline(repT, 'contacts', contact.id).expect(200);
      const { data } = res.body as Timeline;
      expect(data).toHaveLength(1);
      expect(data[0].metadata).toEqual({ kind: 'deal.stage_changed' });
      const text = JSON.stringify(res.body);
      for (const secret of [
        deal.id,
        pipeline.stages[0].id,
        pipeline.stages[1].id,
        'Secret Renewal',
        '98765',
        'OPEN',
      ]) {
        expect(text).not.toContain(secret);
      }
    });

    it('those who can see the deal get the details on the same timeline', async () => {
      const contact = await createContact(prisma, { organizationId: orgA.id, ownerId: rep.id });
      const deal = await createDeal(
        prisma,
        { organizationId: orgA.id, ownerId: other.id },
        { pipelineId: pipeline.id, stageId: pipeline.stages[0].id },
        { contactId: contact.id },
      );
      await http()
        .post(`${API}/deals/${deal.id}/move`)
        .set(as(otherT))
        .send({ stageId: pipeline.stages[1].id })
        .expect(200);
      await waitFor(async () => (await prisma.activity.count()) >= 2);
      await drained();

      const { data } = (await timeline(adminT, 'contacts', contact.id).expect(200))
        .body as Timeline;
      expect(data[0].metadata).toMatchObject({ deal: { dealId: deal.id } });
    });
  });

  describe('cursor pagination', () => {
    async function seed(count: number, at: Date, lead: { id: string }) {
      for (let i = 0; i < count; i++) {
        await prisma.activity.create({
          data: {
            organizationId: orgA.id,
            actorId: rep.id,
            type: 'NOTE',
            subject: `n${i}`,
            leadId: lead.id,
            occurredAt: at,
          },
        });
      }
    }

    it('walks every entry exactly once, newest first, ties broken by id', async () => {
      const lead = await leadOf(rep);
      await seed(3, new Date('2026-01-01T00:00:00Z'), lead); // three entries share an instant
      await seed(2, new Date('2026-02-01T00:00:00Z'), lead);

      const seen: Entry[] = [];
      let cursor: string | null = null;
      do {
        const query = `?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
        const page = (await timeline(repT, 'leads', lead.id, query).expect(200)).body as Timeline;
        expect(page.data.length).toBeLessThanOrEqual(2);
        seen.push(...page.data);
        cursor = page.meta.nextCursor;
      } while (cursor);

      expect(seen).toHaveLength(5);
      expect(new Set(seen.map((e) => e.id)).size).toBe(5);
      const keys = seen.map((e) => `${e.occurredAt}|${e.id}`);
      expect(keys).toEqual([...keys].sort().reverse());
    });

    it('an entry added between two pages does not shuffle the pages', async () => {
      const lead = await leadOf(rep);
      await seed(3, new Date('2026-01-01T00:00:00Z'), lead);
      const first = (await timeline(repT, 'leads', lead.id, '?limit=2').expect(200))
        .body as Timeline;
      await note(repT, 'leads', lead.id, { type: 'NOTE', subject: 'late' }).expect(201);
      const second = (
        await timeline(repT, 'leads', lead.id, `?limit=2&cursor=${first.meta.nextCursor}`).expect(
          200,
        )
      ).body as Timeline;
      const ids = [...first.data, ...second.data].map((e) => e.id);
      expect(new Set(ids).size).toBe(3);
      expect(second.meta.nextCursor).toBeNull();
    });

    it('a cursor from another organization is 400 INVALID_CURSOR', async () => {
      const leadA = await leadOf(rep);
      await seed(3, new Date('2026-01-01T00:00:00Z'), leadA);
      const leadB = await createLead(prisma, { organizationId: orgB.id, ownerId: repB.id });
      await prisma.activity.createMany({
        data: [0, 1, 2].map((i) => ({
          organizationId: orgB.id,
          type: ActivityType.NOTE,
          subject: `b${i}`,
          leadId: leadB.id,
          occurredAt: new Date(2026, 0, i + 1),
        })),
      });
      const foreign = (await timeline(adminBT, 'leads', leadB.id, '?limit=1').expect(200))
        .body as Timeline;
      expect(foreign.meta.nextCursor).toBeTruthy();

      const res = await timeline(repT, 'leads', leadA.id, `?cursor=${foreign.meta.nextCursor}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_CURSOR');
    });

    it.each([
      ['garbage', 'not-a-cursor'],
      ['a base64 json without the fields', Buffer.from('{"o":1}').toString('base64url')],
    ])('a tampered cursor (%s) is 400 INVALID_CURSOR', async (_name, cursor) => {
      const lead = await leadOf(rep);
      const res = await timeline(repT, 'leads', lead.id, `?cursor=${cursor}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_CURSOR');
    });

    it.each(['0', '101', '-1', 'abc'])(
      'limit=%s is rejected (the limit is capped)',
      async (limit) => {
        const lead = await leadOf(rep);
        await timeline(repT, 'leads', lead.id, `?limit=${limit}`).expect(400);
      },
    );
  });

  describe('deleting', () => {
    const manualNote = (lead: { id: string }, actorId: string) =>
      prisma.activity.create({
        data: { organizationId: orgA.id, actorId, type: 'NOTE', subject: 'mine', leadId: lead.id },
      });
    const system = (lead: { id: string }) =>
      prisma.activity.create({
        data: {
          organizationId: orgA.id,
          type: 'SYSTEM',
          subject: 'Lead assigned',
          leadId: lead.id,
        },
      });
    const remove = (tokens: Tokens, id: string) =>
      http().delete(`${API}/activities/${id}`).set(as(tokens));
    const exists = async (id: string) => (await prisma.activity.count({ where: { id } })) === 1;

    it('the author deletes their own note', async () => {
      const lead = await leadOf(rep);
      const created = await note(repT, 'leads', lead.id, { type: 'NOTE', subject: 's' }).expect(
        201,
      );
      await remove(repT, created.body.id).expect(204);
      expect(await exists(created.body.id)).toBe(false);
    });

    it('404 for an author who lost sight of the lead, and the note stays', async () => {
      const lead = await leadOf(rep);
      const mine = await manualNote(lead, rep.id);
      await prisma.lead.update({ where: { id: lead.id }, data: { ownerId: other.id } });
      await remove(repT, mine.id).expect(404);
      expect(await exists(mine.id)).toBe(true);
    });

    it('404 for someone who never saw the lead (not 403, so existence is not confirmed)', async () => {
      const lead = await leadOf(rep);
      const mine = await manualNote(lead, rep.id);
      await remove(otherT, mine.id).expect(404);
      expect(await exists(mine.id)).toBe(true);
    });

    it('403 ACTIVITY_DELETE_RESTRICTED for a manager who sees the lead but did not write the note', async () => {
      const lead = await leadOf(rep);
      const mine = await manualNote(lead, rep.id);
      const res = await remove(managerT, mine.id);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ACTIVITY_DELETE_RESTRICTED');
      expect(await exists(mine.id)).toBe(true);
    });

    it('an admin deletes any manual entry', async () => {
      const lead = await leadOf(rep);
      const mine = await manualNote(lead, rep.id);
      await remove(adminT, mine.id).expect(204);
      expect(await exists(mine.id)).toBe(false);
    });

    it('409 ACTIVITY_IMMUTABLE for a system entry, for the owner and for an admin alike', async () => {
      const lead = await leadOf(rep);
      const entry = await system(lead);
      for (const tokens of [repT, adminT]) {
        const res = await remove(tokens, entry.id);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('ACTIVITY_IMMUTABLE');
      }
      expect(await exists(entry.id)).toBe(true);
    });

    it('a system entry on a lead the caller cannot see is 404, not 409', async () => {
      const lead = await leadOf(rep);
      const entry = await system(lead);
      await remove(otherT, entry.id).expect(404);
    });

    it('404 for an unknown id', async () => {
      await remove(repT, MISSING_ID).expect(404);
    });

    it('there is no edit endpoint', async () => {
      const lead = await leadOf(rep);
      const mine = await manualNote(lead, rep.id);
      await http()
        .patch(`${API}/activities/${mine.id}`)
        .set(as(repT))
        .send({ subject: 'x' })
        .expect(404);
    });
  });

  describe('the database', () => {
    it('refuses an activity that is linked to nothing (CHECK Activity_has_link_check)', async () => {
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "Activity" ("id","organizationId","type","subject") VALUES (gen_random_uuid(), '${orgA.id}', 'NOTE', 'orphan')`,
        ),
      ).rejects.toThrow(/Activity_has_link_check|check constraint/i);
      expect(await prisma.activity.count()).toBe(0);
    });

    it('refuses a link to a record of another organization (composite foreign key)', async () => {
      const leadB = await createLead(prisma, { organizationId: orgB.id, ownerId: repB.id });
      await expect(
        prisma.activity.create({
          data: { organizationId: orgA.id, type: 'NOTE', subject: 'x', leadId: leadB.id },
        }),
      ).rejects.toThrow();
    });
  });

  describe('tenant isolation', () => {
    it('organization B cannot read, write or delete organization A activities', async () => {
      const lead = await leadOf(rep);
      const mine = await prisma.activity.create({
        data: {
          organizationId: orgA.id,
          actorId: rep.id,
          type: 'NOTE',
          subject: 's',
          leadId: lead.id,
        },
      });
      await timeline(adminBT, 'leads', lead.id).expect(404);
      await note(adminBT, 'leads', lead.id, { type: 'NOTE', subject: 'x' }).expect(404);
      await http().delete(`${API}/activities/${mine.id}`).set(as(adminBT)).expect(404);
      expect(await entriesOf({ leadId: lead.id })).toHaveLength(1);
    });

    it('the worker cannot write a job for organization A against a record of organization B', async () => {
      const leadB = await createLead(prisma, { organizationId: orgB.id, ownerId: repB.id });
      const job: CreateActivityJob = {
        organizationId: orgA.id,
        actorId: orgA.admin.id,
        type: ActivityType.SYSTEM,
        subject: 'Lead assigned',
        metadata: { kind: 'lead.assigned' },
        occurredAt: new Date().toISOString(),
        target: { kind: 'lead', id: leadB.id },
        dedupeKey: 'cross-tenant-1',
      };
      // Direct, as the processor does it: in the tenant named by the payload.
      expect(await asWorker(orgA.id, () => app.get(ActivitiesService).createFromJob(job))).toBe(
        'unknownTarget',
      );
      // The same job travelling through the real queue and worker.
      await queue.add(CREATE_ACTIVITY_JOB, { ...job, dedupeKey: 'cross-tenant-2' });
      await drained();
      expect(await prisma.activity.count()).toBe(0);
    });

    it('a payload that disagrees with the tenant it runs in is still rejected by the database', async () => {
      const leadB = await createLead(prisma, { organizationId: orgB.id, ownerId: repB.id });
      const job: CreateActivityJob = {
        organizationId: orgB.id,
        actorId: repB.id,
        type: ActivityType.SYSTEM,
        subject: 'Lead assigned',
        metadata: { kind: 'lead.assigned' },
        occurredAt: new Date().toISOString(),
        target: { kind: 'lead', id: leadB.id },
        dedupeKey: 'cross-tenant-3',
      };
      // Context says A, payload says B: the scoped client writes organization A, so the composite
      // key (leadId, organizationId) does not exist.
      expect(await asWorker(orgA.id, () => app.get(ActivitiesService).createFromJob(job))).toBe(
        'unknownTarget',
      );
      expect(await prisma.activity.count()).toBe(0);
    });

    it('a worker writes into the organization of the payload when everything matches', async () => {
      const lead = await leadOf(rep);
      const job: CreateActivityJob = {
        organizationId: orgA.id,
        actorId: rep.id,
        type: ActivityType.SYSTEM,
        subject: 'Lead assigned',
        metadata: { kind: 'lead.assigned' },
        occurredAt: new Date().toISOString(),
        target: { kind: 'lead', id: lead.id },
        dedupeKey: 'same-tenant',
      };
      expect(await asWorker(orgA.id, () => app.get(ActivitiesService).createFromJob(job))).toBe(
        'created',
      );
      expect((await entriesOf({ leadId: lead.id }))[0].organizationId).toBe(orgA.id);
    });
  });
});
