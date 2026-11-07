import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { Queue } from 'bullmq';
import request from 'supertest';
import type { PrismaClient } from '../../prisma/seed/prisma-client';
import { NotificationType } from '../../src/generated/prisma/client';
import { QUEUE_NAMES } from '../../src/infrastructure/queue/queue.constants';
import { TenantContextService } from '../../src/common/tenant/tenant-context.service';
import {
  CREATE_NOTIFICATION_JOB,
  CreateNotificationJob,
} from '../../src/modules/notifications/notification-job';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { createLead } from '../factories/crm.factory';
import { createTestPrisma, resetDatabase } from '../factories/database';
import {
  createOrganization,
  createUser,
  type TestOrganization,
  type TestUser,
} from '../factories/organization.factory';
import { createTestApp, purgeTestQueues } from '../setup/create-test-app';
import { waitFor } from '../support/wait-for';

const API = '/api/v1/notifications';
const MISSING_ID = '11111111-1111-4111-8111-111111111111';

interface Tokens {
  accessToken: string;
}
interface NotificationBody {
  id: string;
  type: string;
  readAt: string | null;
  payload: Record<string, string> | null;
}

// The queues run against the REAL compose Redis, under a prefix private to this suite (see
// createTestApp): workers are on, so a task assignment travels event -> queue -> worker -> table.
describe('Notifications (e2e, real Redis)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let queue: Queue;
  let orgA: TestOrganization;
  let orgB: TestOrganization;
  let rep: TestUser;
  let other: TestUser;
  let repB: TestUser;
  let adminT: Tokens;
  let repT: Tokens;
  let otherT: Tokens;
  let repBT: Tokens;

  const http = () => request(app.getHttpServer());
  const signIn = async ({ email, password }: Pick<TestUser, 'email' | 'password'>) =>
    (await http().post('/api/v1/auth/login').send({ email, password }).expect(200)).body as Tokens;
  const as = (tokens: Tokens) => ({ Authorization: `Bearer ${tokens.accessToken}` });
  const assignTask = (assignee: TestUser) =>
    http()
      .post('/api/v1/tasks')
      .set(as(adminT))
      .send({ title: 'Call back', assigneeId: assignee.id })
      .expect(201);
  const rowsOf = (user: TestUser) => prisma.notification.findMany({ where: { userId: user.id } });
  const jobFor = (
    org: TestOrganization,
    user: TestUser,
    overrides: Partial<CreateNotificationJob> = {},
  ): CreateNotificationJob => ({
    organizationId: org.id,
    userId: user.id,
    type: NotificationType.TASK_ASSIGNED,
    title: 'A task was assigned to you',
    body: null,
    data: { taskId: 'T' },
    dedupeKey: `test-${Math.random().toString(36).slice(2)}`,
    ...overrides,
  });
  const service = () => app.get(NotificationsService);
  // Runs `fn` as the worker does: inside the tenant named by the payload.
  const asWorker = <T>(organizationId: string, fn: () => Promise<T>) =>
    app.get(TenantContextService).run(organizationId, fn);

  beforeAll(async () => {
    app = await createTestApp({ queue: { workers: true } });
    prisma = createTestPrisma();
    queue = app.get<Queue>(getQueueToken(QUEUE_NAMES.NOTIFICATIONS), { strict: false });
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
    rep = await createUser(prisma, orgA);
    other = await createUser(prisma, orgA);
    repB = await createUser(prisma, orgB);
    adminT = await signIn(orgA.admin);
    repT = await signIn(rep);
    otherT = await signIn(other);
    repBT = await signIn(repB);
  });

  describe('delivery through the queue', () => {
    it('assigning a task notifies the assignee, and only the assignee', async () => {
      const task = (await assignTask(rep)).body as { id: string };

      const [row] = await waitFor(async () => {
        const rows = await rowsOf(rep);
        return rows.length > 0 && rows;
      });
      expect(row).toMatchObject({
        type: NotificationType.TASK_ASSIGNED,
        organizationId: orgA.id,
        payload: { taskId: task.id },
        readAt: null,
      });
      expect(await rowsOf(other)).toHaveLength(0);
      expect(await rowsOf(orgA.admin)).toHaveLength(0);
    });

    it('does not notify a user about a task they assigned to themselves', async () => {
      await http()
        .post('/api/v1/tasks')
        .set(as(adminT))
        .send({ title: 'Mine', assigneeId: orgA.admin.id })
        .expect(201);
      // Wait for the pipeline to drain, then assert nothing was written.
      await waitFor(
        async () => (await queue.getJobCounts('waiting', 'active', 'delayed')).waiting === 0,
      );
      expect(await rowsOf(orgA.admin)).toHaveLength(0);
    });

    it('a repeated event for the same fact produces one notification', async () => {
      const job = jobFor(orgA, rep);
      await queue.add(CREATE_NOTIFICATION_JOB, job, { jobId: 'first' });
      await queue.add(CREATE_NOTIFICATION_JOB, job, { jobId: 'second' });
      await waitFor(async () => (await rowsOf(rep)).length >= 1);
      await waitFor(async () => (await queue.getJobCounts('waiting', 'active')).active === 0);
      expect(await rowsOf(rep)).toHaveLength(1);
    });

    it('retries a job after a transient failure and still writes exactly one row', async () => {
      const spy = vi
        .spyOn(service(), 'createFromJob')
        .mockRejectedValueOnce(new Error('database restarting'));
      try {
        const job = jobFor(orgA, rep);
        await queue.add(CREATE_NOTIFICATION_JOB, job, {
          jobId: job.dedupeKey,
          attempts: 3,
          backoff: { type: 'fixed', delay: 100 },
        });

        await waitFor(async () => (await rowsOf(rep)).length === 1);
        const stored = await queue.getJob(job.dedupeKey);
        expect(stored?.attemptsMade).toBe(2);
        expect(spy).toHaveBeenCalledTimes(2);
        expect(await rowsOf(rep)).toHaveLength(1);
      } finally {
        spy.mockRestore();
      }
    });

    it('gives up after the last attempt and keeps the job as failed', async () => {
      const spy = vi.spyOn(service(), 'createFromJob').mockRejectedValue(new Error('always down'));
      try {
        const job = jobFor(orgA, rep);
        await queue.add(CREATE_NOTIFICATION_JOB, job, {
          jobId: job.dedupeKey,
          attempts: 2,
          backoff: { type: 'fixed', delay: 50 },
        });

        const failed = await waitFor(async () => {
          const stored = await queue.getJob(job.dedupeKey);
          return (await stored?.isFailed()) ? stored : false;
        });
        expect(failed.attemptsMade).toBe(2);
        expect(failed.failedReason).toBe('always down');
        expect(await rowsOf(rep)).toHaveLength(0);
      } finally {
        spy.mockRestore();
      }
    });

    it('does not retry a job without a tenant', async () => {
      await queue.add(
        CREATE_NOTIFICATION_JOB,
        { userId: rep.id, title: 'x' },
        { jobId: 'no-tenant', attempts: 5, backoff: { type: 'fixed', delay: 50 } },
      );
      const failed = await waitFor(async () => {
        const stored = await queue.getJob('no-tenant');
        return (await stored?.isFailed()) ? stored : false;
      });
      expect(failed.attemptsMade).toBe(1);
      expect(failed.failedReason).toBe('Job payload has no organizationId');
    });

    it('completes, without retrying or writing, when the recipient does not exist', async () => {
      const job = jobFor(orgA, rep, { userId: MISSING_ID });
      await queue.add(CREATE_NOTIFICATION_JOB, job, { jobId: job.dedupeKey });
      const done = await waitFor(async () => {
        const stored = await queue.getJob(job.dedupeKey);
        return (await stored?.isCompleted()) ? stored : false;
      });
      expect(done.attemptsMade).toBe(1);
      expect(await prisma.notification.count()).toBe(0);
    });

    it('never delivers into another organization (tenant isolation of the worker)', async () => {
      // Organization A names a recipient who belongs to organization B.
      const job = jobFor(orgA, repB);
      await queue.add(CREATE_NOTIFICATION_JOB, job, { jobId: job.dedupeKey });
      await waitFor(async () => (await queue.getJob(job.dedupeKey))?.isCompleted());
      expect(await prisma.notification.count()).toBe(0);
    });
  });

  describe('concurrent duplicate processing', () => {
    it('many workers running the same job at once create exactly one notification', async () => {
      const job = jobFor(orgA, rep);
      const outcomes = await Promise.all(
        Array.from({ length: 25 }, () => asWorker(orgA.id, () => service().createFromJob(job))),
      );
      expect(outcomes.filter((outcome) => outcome === 'created')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome === 'duplicate')).toHaveLength(24);
      expect(await rowsOf(rep)).toHaveLength(1);
    });

    it('the same key is independent per organization, and per fact within one', async () => {
      const key = 'shared-key';
      await asWorker(orgA.id, () => service().createFromJob(jobFor(orgA, rep, { dedupeKey: key })));
      await asWorker(orgB.id, () =>
        service().createFromJob(jobFor(orgB, repB, { dedupeKey: key })),
      );
      await asWorker(orgA.id, () =>
        service().createFromJob(jobFor(orgA, rep, { dedupeKey: 'another' })),
      );
      expect(await prisma.notification.count()).toBe(3);
    });

    it('many different jobs processed concurrently are all written', async () => {
      const jobs = Array.from({ length: 30 }, () => jobFor(orgA, rep));
      await Promise.all(
        jobs.map((job) => queue.add(CREATE_NOTIFICATION_JOB, job, { jobId: job.dedupeKey })),
      );
      await waitFor(async () => (await rowsOf(rep)).length === 30);
      expect(new Set((await rowsOf(rep)).map((row) => row.dedupeKey)).size).toBe(30);
    });
  });

  describe('lead assignment (lead.assigned)', () => {
    const leadsAssigned = (user: TestUser) =>
      prisma.notification.findMany({
        where: { userId: user.id, type: NotificationType.LEAD_ASSIGNED },
      });
    const createLeadFor = (tokens: Tokens, ownerId?: string) =>
      http()
        .post('/api/v1/leads')
        .set(as(tokens))
        .send({ firstName: 'Omar', lastName: 'Khaled', source: 'REFERRAL', ownerId })
        .expect(201);
    // A second, different assignment whose notification we wait for: once it has arrived, anything
    // sent earlier has already passed through the pipeline, so "nothing else" can be asserted.
    const drain = async () => {
      const marker = (await createLeadFor(adminT, other.id)).body as { id: string };
      await waitFor(async () => {
        const rows = await leadsAssigned(other);
        return rows.some((row) => (row.payload as { leadId: string }).leadId === marker.id);
      });
    };

    it('creating a lead for someone notifies the new owner only, with the lead id', async () => {
      const lead = (await createLeadFor(adminT, rep.id)).body as { id: string };
      const [row] = await waitFor(async () => {
        const rows = await leadsAssigned(rep);
        return rows.length > 0 && rows;
      });
      expect(row).toMatchObject({
        organizationId: orgA.id,
        type: NotificationType.LEAD_ASSIGNED,
        payload: { leadId: lead.id },
        readAt: null,
      });
      expect(await leadsAssigned(orgA.admin)).toHaveLength(0);
      expect(await leadsAssigned(other)).toHaveLength(0);
    });

    it('creating a lead for yourself notifies nobody', async () => {
      await createLeadFor(adminT);
      await createLeadFor(repT);
      await drain();
      expect(await leadsAssigned(orgA.admin)).toHaveLength(0);
      expect(await leadsAssigned(rep)).toHaveLength(0);
    });

    it('transferring a lead notifies the NEW owner only; re-sending the same owner notifies nobody', async () => {
      const lead = (await createLeadFor(adminT, rep.id)).body as { id: string };
      await waitFor(async () => (await leadsAssigned(rep)).length === 1);

      await http()
        .patch(`/api/v1/leads/${lead.id}`)
        .set(as(adminT))
        .send({ ownerId: other.id })
        .expect(200);
      await waitFor(async () => {
        const rows = await leadsAssigned(other);
        return rows.some((row) => (row.payload as { leadId: string }).leadId === lead.id);
      });

      // Same owner again, and an edit that does not touch the owner.
      await http()
        .patch(`/api/v1/leads/${lead.id}`)
        .set(as(adminT))
        .send({ ownerId: other.id })
        .expect(200);
      await http()
        .patch(`/api/v1/leads/${lead.id}`)
        .set(as(adminT))
        .send({ notes: 'call back' })
        .expect(200);
      await drain();

      const forLead = (await leadsAssigned(other)).filter(
        (row) => (row.payload as { leadId: string }).leadId === lead.id,
      );
      expect(forLead).toHaveLength(1);
      expect(await leadsAssigned(rep)).toHaveLength(1); // the previous owner is told nothing new
      expect(await leadsAssigned(orgA.admin)).toHaveLength(0);
    });

    it('lead conversion sends no lead.assigned (only lead.converted to the owner)', async () => {
      const lead = await createLead(
        prisma,
        { organizationId: orgA.id, ownerId: rep.id },
        { status: 'QUALIFIED' },
      );
      await http().post(`/api/v1/leads/${lead.id}/convert`).set(as(adminT)).send({}).expect(200);
      await waitFor(async () =>
        (await rowsOf(rep)).some((row) => row.type === NotificationType.LEAD_CONVERTED),
      );
      await drain();
      expect(await leadsAssigned(rep)).toHaveLength(0);
    });

    it('tenant isolation: a lead cannot be assigned across organizations, and nobody there is notified', async () => {
      const res = await http()
        .post('/api/v1/leads')
        .set(as(adminT))
        .send({ firstName: 'O', lastName: 'K', source: 'OTHER', ownerId: repB.id })
        .expect(400);
      expect(res.body.code).toBe('INVALID_OWNER');
      await drain();
      expect(await leadsAssigned(repB)).toHaveLength(0);
      expect(await prisma.notification.count({ where: { organizationId: orgB.id } })).toBe(0);
    });
  });

  describe('API', () => {
    const seed = async (user: TestUser, org: TestOrganization, count: number) => {
      for (let i = 0; i < count; i++) {
        await prisma.notification.create({
          data: {
            organizationId: org.id,
            userId: user.id,
            type: NotificationType.TASK_ASSIGNED,
            title: `N${i}`,
            payload: { taskId: `t${i}` },
            createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, i)),
          },
        });
      }
    };

    it('requires authentication', async () => {
      await http().get(API).expect(401);
      await http().get(`${API}/unread-count`).expect(401);
      await http().post(`${API}/read-all`).expect(401);
      await http().post(`${API}/${MISSING_ID}/read`).expect(401);
    });

    it('lists only your own notifications, newest first, with paging', async () => {
      await seed(rep, orgA, 3);
      await seed(other, orgA, 2);
      await seed(repB, orgB, 2);

      const res = await http().get(`${API}?limit=2`).set(as(repT)).expect(200);
      expect(res.body.meta).toMatchObject({ page: 1, limit: 2, total: 3, totalPages: 2 });
      expect((res.body.data as { title: string }[]).map((n) => n.title)).toEqual(['N2', 'N1']);

      const second = await http().get(`${API}?limit=2&page=2`).set(as(repT)).expect(200);
      expect((second.body.data as { title: string }[]).map((n) => n.title)).toEqual(['N0']);
    });

    it('an admin does not see other peoples notifications either', async () => {
      await seed(rep, orgA, 2);
      const res = await http().get(API).set(as(adminT)).expect(200);
      expect(res.body.meta.total).toBe(0);
    });

    it('filters unread and counts them', async () => {
      await seed(rep, orgA, 3);
      const [first] = (await http().get(API).set(as(repT))).body.data as NotificationBody[];
      await http().post(`${API}/${first.id}/read`).set(as(repT)).expect(200);

      const unread = await http().get(`${API}?unread=true`).set(as(repT)).expect(200);
      expect(unread.body.meta.total).toBe(2);
      const count = await http().get(`${API}/unread-count`).set(as(repT)).expect(200);
      expect(count.body).toEqual({ count: 2 });
    });

    it('marking one as read is idempotent and keeps the first readAt', async () => {
      await seed(rep, orgA, 1);
      const [n] = (await http().get(API).set(as(repT))).body.data as NotificationBody[];
      const first = await http().post(`${API}/${n.id}/read`).set(as(repT)).expect(200);
      expect(first.body.readAt).not.toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const again = await http().post(`${API}/${n.id}/read`).set(as(repT)).expect(200);
      expect(again.body.readAt).toBe(first.body.readAt);
    });

    it('read-all marks everything of yours and nothing of others, and repeats safely', async () => {
      await seed(rep, orgA, 3);
      await seed(other, orgA, 2);
      const first = await http().post(`${API}/read-all`).set(as(repT)).expect(200);
      expect(first.body).toEqual({ updated: 3 });
      const again = await http().post(`${API}/read-all`).set(as(repT)).expect(200);
      expect(again.body).toEqual({ updated: 0 });
      const others = await http().get(`${API}/unread-count`).set(as(otherT)).expect(200);
      expect(others.body).toEqual({ count: 2 });
    });

    it('answers 404 for a notification that is someone elses or another organizations', async () => {
      await seed(other, orgA, 1);
      await seed(repB, orgB, 1);
      const theirs = await prisma.notification.findFirstOrThrow({ where: { userId: other.id } });
      const foreign = await prisma.notification.findFirstOrThrow({ where: { userId: repB.id } });

      for (const id of [theirs.id, foreign.id, MISSING_ID]) {
        const res = await http().post(`${API}/${id}/read`).set(as(repT)).expect(404);
        expect(res.body.code).toBe('RESOURCE_NOT_FOUND');
      }
      expect(
        (await prisma.notification.findUniqueOrThrow({ where: { id: theirs.id } })).readAt,
      ).toBeNull();
      expect(
        (await prisma.notification.findUniqueOrThrow({ where: { id: foreign.id } })).readAt,
      ).toBeNull();
      // Organization B's user sees none of organization A's.
      expect((await http().get(API).set(as(repBT))).body.meta.total).toBe(1);
    });

    it('validates input', async () => {
      await http().get(`${API}?page=0`).set(as(repT)).expect(400);
      await http().get(`${API}?unread=maybe`).set(as(repT)).expect(400);
      await http().get(`${API}?sortBy=title`).set(as(repT)).expect(400);
      await http().post(`${API}/not-a-uuid/read`).set(as(repT)).expect(400);
    });
  });

  describe('readiness', () => {
    it('reports redis up through the queue connection', async () => {
      const res = await http().get('/health/ready').expect(200);
      expect(res.body.info.redis.status).toBe('up');
    });
  });
});

// The default e2e wiring has no reachable Redis (port 1): the API must keep working.
describe('Notifications without Redis (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = createTestPrisma();
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('still assigns a task when the queue cannot be reached; the notification is lost', async () => {
    await resetDatabase(prisma);
    const org = await createOrganization(prisma, 'noredis');
    const user = await createUser(prisma, org);
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: org.admin.email, password: org.admin.password })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .send({ title: 'Call back', assigneeId: user.id })
      .expect(201);

    expect(await prisma.notification.count()).toBe(0);
  });
});
