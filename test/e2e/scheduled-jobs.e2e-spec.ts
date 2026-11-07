import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { PrismaClient } from '../../prisma/seed/prisma-client';
import { TenantContextService } from '../../src/common/tenant/tenant-context.service';
import { NotificationType, TaskStatus } from '../../src/generated/prisma/client';
import { QUEUE_NAMES } from '../../src/infrastructure/queue/queue.constants';
import { NotificationRetentionProcessor } from '../../src/jobs/notifications/notification-retention.processor';
import { SweepsProcessor } from '../../src/jobs/sweeps/sweeps.processor';
import { RefreshTokenCleanupService } from '../../src/modules/auth/refresh-token-cleanup.service';
import { NotificationDispatcher } from '../../src/modules/notifications/notification-dispatcher.service';
import { taskDueSoonJob } from '../../src/modules/notifications/notification-job.factory';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { TaskAlertsService } from '../../src/modules/tasks/task-alerts.service';
import { TasksRepository } from '../../src/modules/tasks/tasks.repository';
import { createTask } from '../factories/crm.factory';
import { createTestPrisma, resetDatabase } from '../factories/database';
import {
  createOrganization,
  createUser,
  type TestOrganization,
  type TestUser,
} from '../factories/organization.factory';
import { createTestApp, purgeTestQueues } from '../setup/create-test-app';
import { waitFor } from '../support/wait-for';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const ago = (ms: number) => new Date(Date.now() - ms);

// Real compose Redis and real workers (see createTestApp). The repeatable schedules are removed once
// the app is up, so the only sweeps that run are the ones a test starts itself.
describe('Scheduled jobs (e2e, real Redis)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let orgA: TestOrganization;
  let orgB: TestOrganization;
  let repA: TestUser;
  let repB: TestUser;
  let registeredSchedulers: { key: string; pattern?: string | null; every?: number | null }[];

  const queueOf = (name: string) => app.get<Queue>(getQueueToken(name), { strict: false });
  const sweeps = () => app.get(SweepsProcessor);
  const sweepNamed = (name: string) => {
    const sweep = sweeps().sweeps.find((candidate) => candidate.name === name);
    if (!sweep) throw new Error(`no sweep ${name}`);
    return sweep;
  };
  const asWorker = <T>(organizationId: string, fn: () => Promise<T>) =>
    app.get(TenantContextService).run(organizationId, fn);
  const notificationsOf = (user: TestUser, type?: NotificationType) =>
    prisma.notification.findMany({ where: { userId: user.id, ...(type && { type }) } });
  const dueReminder = (org: TestOrganization, user: TestUser, overrides = {}) =>
    createTask(
      prisma,
      { organizationId: org.id, assigneeId: user.id },
      { reminderAt: ago(5 * MINUTE), dueDate: new Date(Date.now() + DAY), ...overrides },
    );
  const overdueTask = (org: TestOrganization, user: TestUser, overrides = {}) =>
    createTask(
      prisma,
      { organizationId: org.id, assigneeId: user.id },
      { dueDate: ago(2 * 60 * MINUTE), ...overrides },
    );

  beforeAll(async () => {
    app = await createTestApp({ queue: { workers: true } });
    prisma = createTestPrisma();
    const sweepsQueue = queueOf(QUEUE_NAMES.SWEEPS);
    // Registration happens during bootstrap; read it before taking the schedules away.
    registeredSchedulers = await sweepsQueue.getJobSchedulers();
    for (const { key } of registeredSchedulers) await sweepsQueue.removeJobScheduler(key);
    await sweepsQueue.obliterate({ force: true });
  });

  afterAll(async () => {
    await purgeTestQueues(app);
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    for (const name of Object.values(QUEUE_NAMES)) {
      await queueOf(name).obliterate({ force: true });
    }
    await resetDatabase(prisma);
    orgA = await createOrganization(prisma, 'orga');
    orgB = await createOrganization(prisma, 'orgb');
    repA = await createUser(prisma, orgA);
    repB = await createUser(prisma, orgB);
  });

  describe('schedules', () => {
    it('registers one repeatable sweep per job when the app starts', () => {
      expect(
        registeredSchedulers.map(({ key, pattern, every }) => [key, pattern ?? every]).sort(),
      ).toEqual(
        [
          ['task-reminders', MINUTE],
          ['task-overdue', 15 * MINUTE],
          ['refresh-token-cleanup', '15 3 * * *'],
          ['notification-retention', '30 3 * * *'],
          ['audit-retention', '45 3 * * *'],
        ].sort(),
      );
    });
  });

  describe('task reminders', () => {
    it('a due reminder reaches the assignee through sweep -> tenant job -> notification queue', async () => {
      const task = await dueReminder(orgA, repA);
      await sweeps().run(sweepNamed('task-reminders'), new Date());

      const [row] = await waitFor(async () => {
        const rows = await notificationsOf(repA, NotificationType.TASK_DUE_SOON);
        return rows.length > 0 && rows;
      });
      expect(row).toMatchObject({ organizationId: orgA.id, payload: { taskId: task.id } });
      expect(
        (await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).reminderSentAt,
      ).not.toBeNull();
    });

    it('does not remind about a future reminder or a closed task', async () => {
      await dueReminder(orgA, repA, { reminderAt: new Date(Date.now() + DAY) });
      await dueReminder(orgA, repA, { status: TaskStatus.COMPLETED });
      await dueReminder(orgA, repA, { status: TaskStatus.CANCELLED });
      const barrier = await dueReminder(orgA, repA);
      await sweeps().run(sweepNamed('task-reminders'), new Date());
      await waitFor(async () => (await notificationsOf(repA)).length > 0);
      expect(await notificationsOf(repA)).toHaveLength(1);
      expect((await notificationsOf(repA))[0].payload).toMatchObject({ taskId: barrier.id });
    });

    it('tenant isolation: another organization with due reminders is served on its own, never mixed up', async () => {
      const taskA = await dueReminder(orgA, repA);
      const taskB = await dueReminder(orgB, repB);
      await sweeps().run(sweepNamed('task-reminders'), new Date());
      await waitFor(
        async () =>
          (await notificationsOf(repA)).length > 0 && (await notificationsOf(repB)).length > 0,
      );
      expect((await notificationsOf(repA))[0]).toMatchObject({
        organizationId: orgA.id,
        payload: { taskId: taskA.id },
      });
      expect((await notificationsOf(repB))[0]).toMatchObject({
        organizationId: orgB.id,
        payload: { taskId: taskB.id },
      });
    });

    it('a per-organization job only touches its own organization', async () => {
      const taskB = await dueReminder(orgB, repB);
      await asWorker(orgA.id, () => app.get(TaskAlertsService).sendDueReminders(new Date()));
      expect(
        (await prisma.task.findUniqueOrThrow({ where: { id: taskB.id } })).reminderSentAt,
      ).toBeNull();
      expect(await notificationsOf(repB)).toHaveLength(0);
    });

    it('an INACTIVE organization is skipped: no job, no notification', async () => {
      await prisma.organization.update({ where: { id: orgB.id }, data: { isActive: false } });
      const taskB = await dueReminder(orgB, repB);
      const overdueB = await overdueTask(orgB, repB);
      await dueReminder(orgA, repA); // the barrier: when A is served, B would have been too

      const now = new Date();
      await sweeps().run(sweepNamed('task-reminders'), now);
      await sweeps().run(sweepNamed('task-overdue'), now);
      await waitFor(async () => (await notificationsOf(repA)).length > 0);

      const queued = await queueOf(QUEUE_NAMES.TASK_REMINDERS).getJobs([
        'waiting',
        'active',
        'delayed',
        'completed',
      ]);
      expect(queued.map((job) => job.data.organizationId)).toEqual([orgA.id]);
      expect(await notificationsOf(repB)).toHaveLength(0);
      expect(
        (await prisma.task.findUniqueOrThrow({ where: { id: taskB.id } })).reminderSentAt,
      ).toBeNull();
      expect(
        (await prisma.task.findUniqueOrThrow({ where: { id: overdueB.id } })).overdueNotifiedAt,
      ).toBeNull();
    });

    it('running the sweep twice creates one tenant job and one notification', async () => {
      await dueReminder(orgA, repA);
      const now = new Date();
      await sweeps().run(sweepNamed('task-reminders'), now);
      await sweeps().run(sweepNamed('task-reminders'), now);
      await waitFor(async () => (await notificationsOf(repA)).length > 0);

      const jobs = await queueOf(QUEUE_NAMES.TASK_REMINDERS).getJobs([
        'waiting',
        'active',
        'delayed',
        'completed',
      ]);
      expect(jobs).toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await notificationsOf(repA)).toHaveLength(1);
    });

    it('running the alert twice, or after a crash between enqueue and marker, still notifies once', async () => {
      const task = await dueReminder(orgA, repA);
      // The crash: the notification job went out, the marker was never set.
      await app.get(NotificationDispatcher).dispatchStrict(
        taskDueSoonJob({
          organizationId: orgA.id,
          taskId: task.id,
          assigneeId: repA.id,
          reminderAt: task.reminderAt as Date,
        }),
      );
      const alerts = app.get(TaskAlertsService);
      await asWorker(orgA.id, () => alerts.sendDueReminders(new Date()));
      await asWorker(orgA.id, () => alerts.sendDueReminders(new Date()));
      await waitFor(async () => (await notificationsOf(repA)).length > 0);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await notificationsOf(repA)).toHaveLength(1);
    });

    it('a reminderAt changed between the read and the marker is NOT marked as sent', async () => {
      const task = await dueReminder(orgA, repA);
      const repository = app.get(TasksRepository);
      const [read] = await asWorker(orgA.id, () => repository.findDueReminders(new Date(), 10));
      expect(read.id).toBe(task.id);

      // Someone reschedules the reminder after the sweep read it.
      const rescheduled = new Date(Date.now() + 60 * MINUTE);
      await prisma.task.update({ where: { id: task.id }, data: { reminderAt: rescheduled } });

      const marked = await asWorker(orgA.id, () => repository.markReminderSent(read, new Date()));
      expect(marked).toBe(false);
      const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
      expect(after.reminderSentAt).toBeNull();
      expect(after.reminderAt?.getTime()).toBe(rescheduled.getTime());
    });

    it('a reminder already sent is not marked twice', async () => {
      const task = await dueReminder(orgA, repA);
      const repository = app.get(TasksRepository);
      const [read] = await asWorker(orgA.id, () => repository.findDueReminders(new Date(), 10));
      expect(await asWorker(orgA.id, () => repository.markReminderSent(read, new Date()))).toBe(
        true,
      );
      expect(await asWorker(orgA.id, () => repository.markReminderSent(read, new Date()))).toBe(
        false,
      );
      expect(
        (await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).reminderSentAt,
      ).not.toBeNull();
    });
  });

  describe('overdue notices', () => {
    it('an overdue task reaches the assignee once', async () => {
      const task = await overdueTask(orgA, repA);
      await sweeps().run(sweepNamed('task-overdue'), new Date());
      const [row] = await waitFor(async () => {
        const rows = await notificationsOf(repA, NotificationType.TASK_OVERDUE);
        return rows.length > 0 && rows;
      });
      expect(row.payload).toMatchObject({ taskId: task.id });
      expect(
        (await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).overdueNotifiedAt,
      ).not.toBeNull();
    });

    it('ignores tasks that are not overdue, closed, or have no due date', async () => {
      await overdueTask(orgA, repA, { dueDate: new Date(Date.now() + DAY) });
      await overdueTask(orgA, repA, { status: TaskStatus.COMPLETED });
      await createTask(prisma, { organizationId: orgA.id, assigneeId: repA.id });
      await sweeps().run(sweepNamed('task-overdue'), new Date());
      await asWorker(orgA.id, () => app.get(TaskAlertsService).sendOverdueNotices(new Date()));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await notificationsOf(repA)).toHaveLength(0);
    });

    it('a due date changed between the read and the marker is not marked as notified', async () => {
      const task = await overdueTask(orgA, repA);
      const repository = app.get(TasksRepository);
      const [read] = await asWorker(orgA.id, () =>
        repository.findOverdueUnnotified(new Date(), 10),
      );
      await prisma.task.update({ where: { id: task.id }, data: { dueDate: ago(30 * MINUTE) } });
      expect(await asWorker(orgA.id, () => repository.markOverdueNotified(read, new Date()))).toBe(
        false,
      );
      expect(
        (await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).overdueNotifiedAt,
      ).toBeNull();
    });

    describe('through the API', () => {
      let token: string;
      const http = () => request(app.getHttpServer());
      beforeEach(async () => {
        const login = await http()
          .post('/api/v1/auth/login')
          .send({ email: orgA.admin.email, password: orgA.admin.password })
          .expect(200);
        token = (login.body as { accessToken: string }).accessToken;
      });
      const bearer = () => ({ Authorization: `Bearer ${token}` });
      const sendOverdue = () =>
        asWorker(orgA.id, () => app.get(TaskAlertsService).sendOverdueNotices(new Date()));

      it('a REOPENED task is not notified again for the same dueDate', async () => {
        const task = await overdueTask(orgA, repA);
        await sendOverdue();
        await waitFor(async () => (await notificationsOf(repA)).length > 0);

        await http()
          .post(`/api/v1/tasks/${task.id}/status`)
          .set(bearer())
          .send({ status: 'COMPLETED' })
          .expect(200);
        await http()
          .post(`/api/v1/tasks/${task.id}/status`)
          .set(bearer())
          .send({ status: 'OPEN' })
          .expect(200);
        const run = await sendOverdue();

        expect(run.notified).toBe(0);
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(await notificationsOf(repA)).toHaveLength(1);
      });

      it('moving the dueDate re-arms the notice: the new date is announced', async () => {
        const task = await overdueTask(orgA, repA);
        await sendOverdue();
        await waitFor(async () => (await notificationsOf(repA)).length > 0);

        await http()
          .patch(`/api/v1/tasks/${task.id}`)
          .set(bearer())
          .send({ dueDate: ago(10 * MINUTE).toISOString() })
          .expect(200);
        expect(
          (await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).overdueNotifiedAt,
        ).toBeNull();

        await sendOverdue();
        await waitFor(async () => (await notificationsOf(repA)).length > 1);
        expect(await notificationsOf(repA)).toHaveLength(2);
      });

      it('editing something else leaves the marker alone', async () => {
        const task = await overdueTask(orgA, repA);
        await sendOverdue();
        await http()
          .patch(`/api/v1/tasks/${task.id}`)
          .set(bearer())
          .send({ title: 'Renamed' })
          .expect(200);
        expect(
          (await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).overdueNotifiedAt,
        ).not.toBeNull();
      });
    });
  });

  describe('batch cap', () => {
    it('1,200 due tasks are processed exactly once across three sweeps (500 + 500 + 200)', async () => {
      const tasks = Array.from({ length: 1200 }, (_, i) => ({
        id: randomUUID(),
        organizationId: orgA.id,
        assigneeId: repA.id,
        createdById: repA.id,
        title: `Bulk ${i}`,
        reminderAt: new Date(Date.now() - (2 * DAY - i * 1000)),
      }));
      await prisma.task.createMany({ data: tasks });
      const alerts = app.get(TaskAlertsService);

      const runs = [];
      for (let sweep = 0; sweep < 3; sweep++) {
        runs.push(await asWorker(orgA.id, () => alerts.sendDueReminders(new Date())));
      }
      expect(runs).toEqual([
        { notified: 500, superseded: 0, capped: true },
        { notified: 500, superseded: 0, capped: true },
        { notified: 200, superseded: 0, capped: false },
      ]);
      expect(await asWorker(orgA.id, () => alerts.sendDueReminders(new Date()))).toEqual({
        notified: 0,
        superseded: 0,
        capped: false,
      });

      await waitFor(async () => (await prisma.notification.count()) >= 1200, 60_000);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const rows = await prisma.notification.findMany({ select: { payload: true } });
      const taskIds = rows.map(({ payload }) => (payload as { taskId: string }).taskId);
      expect(taskIds).toHaveLength(1200);
      expect(new Set(taskIds)).toEqual(new Set(tasks.map(({ id }) => id)));
      expect(await prisma.task.count({ where: { reminderSentAt: null } })).toBe(0);
    }, 120_000);
  });

  describe('notification retention', () => {
    const notification = (
      org: TestOrganization,
      user: TestUser,
      ageDays: number,
      read: boolean,
      title = 'SECRET-TITLE',
    ) =>
      prisma.notification.create({
        data: {
          organizationId: org.id,
          userId: user.id,
          type: NotificationType.TASK_ASSIGNED,
          title,
          body: 'SECRET-BODY',
          createdAt: ago(ageDays * DAY),
          readAt: read ? ago(ageDays * DAY) : null,
        },
      });

    it('deletes read rows older than 90 days and unread ones older than 180, only', async () => {
      const goneRead = await notification(orgA, repA, 100, true);
      const keptRead = await notification(orgA, repA, 30, true);
      const goneUnread = await notification(orgA, repA, 200, false);
      const keptUnread = await notification(orgA, repA, 100, false);
      const edgeRead = await notification(orgA, repA, 89, true);

      const deleted = await asWorker(orgA.id, () =>
        app.get(NotificationsService).purgeExpired(new Date()),
      );

      expect(deleted).toBe(2);
      const left = (await prisma.notification.findMany({ select: { id: true } })).map(
        ({ id }) => id,
      );
      expect(left.sort()).toEqual([keptRead.id, keptUnread.id, edgeRead.id].sort());
      expect(left).not.toContain(goneRead.id);
      expect(left).not.toContain(goneUnread.id);
    });

    it('tenant isolation: another organization expired rows are not touched by this job', async () => {
      await notification(orgA, repA, 300, true);
      const otherOrg = await notification(orgB, repB, 300, true);
      await asWorker(orgA.id, () => app.get(NotificationsService).purgeExpired(new Date()));
      expect(await prisma.notification.findUnique({ where: { id: otherOrg.id } })).not.toBeNull();
      expect(await prisma.notification.count({ where: { organizationId: orgA.id } })).toBe(0);
    });

    it('logs the number of deleted rows and never their content', async () => {
      await notification(orgA, repA, 300, true);
      await notification(orgA, repA, 300, false);
      const processor = app.get(NotificationRetentionProcessor);
      const log = vi.spyOn(processor['logger'], 'log').mockImplementation(() => undefined);
      const anyLogger = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      await asWorker(orgA.id, () =>
        processor.handle({ data: { organizationId: orgA.id } } as never),
      );

      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: orgA.id, deleted: 2 }),
      );
      const logged = JSON.stringify([log.mock.calls, anyLogger.mock.calls]);
      expect(logged).not.toContain('SECRET-TITLE');
      expect(logged).not.toContain('SECRET-BODY');
      anyLogger.mockRestore();
    });

    it('runs through the daily sweep for every active organization', async () => {
      const goneA = await notification(orgA, repA, 300, true);
      const goneB = await notification(orgB, repB, 300, true);
      await sweeps().run(sweepNamed('notification-retention'), new Date());
      await waitFor(
        async () =>
          (await prisma.notification.count({ where: { id: { in: [goneA.id, goneB.id] } } })) === 0,
      );
    });
  });

  describe('refresh token cleanup', () => {
    let sequence = 0;
    const token = (
      org: TestOrganization,
      user: TestUser,
      familyId: string,
      expiredDaysAgo: number,
      revokedAt: Date | null = null,
    ) =>
      prisma.refreshToken.create({
        data: {
          organizationId: org.id,
          userId: user.id,
          tokenHash: `hash-${++sequence}-${randomUUID()}`,
          familyId,
          expiresAt: ago(expiredDaysAgo * DAY),
          revokedAt,
        },
      });
    const exists = async (id: string) =>
      (await prisma.refreshToken.findUnique({ where: { id } })) !== null;

    it('deletes long-expired tokens only: not those inside the grace period, not a live family, not revoked-but-valid ones', async () => {
      const dead = await token(orgA, repA, randomUUID(), 10, ago(11 * DAY));
      const justExpired = await token(orgA, repA, randomUUID(), 3);
      const aliveFamily = randomUUID();
      const oldInLiveFamily = await token(orgA, repA, aliveFamily, 10, ago(10 * DAY));
      const liveSuccessor = await token(orgA, repA, aliveFamily, -7); // expires in 7 days
      const revokedStillValid = await token(orgA, repA, randomUUID(), -2, ago(DAY));

      const deleted = await asWorker(orgA.id, () =>
        app.get(RefreshTokenCleanupService).purgeExpired(new Date()),
      );

      expect(deleted).toBe(1);
      expect(await exists(dead.id)).toBe(false);
      expect(await exists(justExpired.id)).toBe(true);
      expect(await exists(oldInLiveFamily.id)).toBe(true);
      expect(await exists(liveSuccessor.id)).toBe(true);
      expect(await exists(revokedStillValid.id)).toBe(true);
    });

    it('a family whose only live token is revoked is cleaned up', async () => {
      const family = randomUUID();
      const old = await token(orgA, repA, family, 10, ago(10 * DAY));
      const revokedLive = await token(orgA, repA, family, -3, ago(DAY));
      await asWorker(orgA.id, () => app.get(RefreshTokenCleanupService).purgeExpired(new Date()));
      expect(await exists(old.id)).toBe(false);
      expect(await exists(revokedLive.id)).toBe(true);
    });

    it('tenant isolation: another organization tokens are not touched by this job', async () => {
      const mine = await token(orgA, repA, randomUUID(), 10);
      const theirs = await token(orgB, repB, randomUUID(), 10);
      await asWorker(orgA.id, () => app.get(RefreshTokenCleanupService).purgeExpired(new Date()));
      expect(await exists(mine.id)).toBe(false);
      expect(await exists(theirs.id)).toBe(true);
    });

    it('runs through the daily sweep for every active organization', async () => {
      const a = await token(orgA, repA, randomUUID(), 10);
      const b = await token(orgB, repB, randomUUID(), 10);
      await sweeps().run(sweepNamed('refresh-token-cleanup'), new Date());
      await waitFor(async () => !(await exists(a.id)) && !(await exists(b.id)));
    });
  });
});
