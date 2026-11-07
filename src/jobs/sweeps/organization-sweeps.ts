import { QUEUE_NAMES, QueueName } from '../../infrastructure/queue/queue.constants';
import { JobRepeat } from '../../infrastructure/queue/queue.types';
import { OrganizationWorkRepository } from '../bootstrap/organization-work.repository';

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

// A sweep is a cheap, cross-tenant job that runs on a schedule. It does NOT do the work: it finds
// the organizations that have some and enqueues one tenant job for each (fan-out), so an idle
// system enqueues nothing and the real work runs in the organization's own context.
export interface OrganizationSweep {
  // Scheduler id, sweep job name, per-organization job name and jobId prefix, all in one.
  readonly name: string;
  readonly repeat: JobRepeat;
  // The per-organization job id is `<name>-<organizationId>-<bucket>` where the bucket is the
  // current time divided by this length, so overlapping or repeated sweeps in the same period
  // create ONE job per organization, not several.
  readonly bucketMs: number;
  readonly targetQueue: QueueName;
  // Active organizations with something to do, after `after`, at most `limit`, in id order.
  organizationIds(now: Date, after: string | null, limit: number): Promise<string[]>;
}

// Numbers, and why:
//  - Reminders are the time-sensitive part: every minute, so a reminder is at most one tick late.
//  - Overdue is a status report, not a deadline: every 15 minutes is plenty and 15x fewer queries.
//  - Both look for organizations with pending work first (one grouped, index-served query), so a
//    quiet system costs two cheap queries and zero jobs per tick.
//  - Housekeeping is daily at 03:15 UTC for every active organization (a few jobs per day).
export function buildOrganizationSweeps(work: OrganizationWorkRepository): OrganizationSweep[] {
  return [
    {
      name: 'task-reminders',
      repeat: { every: MINUTE_MS },
      bucketMs: MINUTE_MS,
      targetQueue: QUEUE_NAMES.TASK_REMINDERS,
      organizationIds: (now, after, limit) => work.withDueReminders(now, after, limit),
    },
    {
      name: 'task-overdue',
      repeat: { every: 15 * MINUTE_MS },
      bucketMs: 15 * MINUTE_MS,
      targetQueue: QUEUE_NAMES.TASK_OVERDUE,
      organizationIds: (now, after, limit) => work.withUnnotifiedOverdueTasks(now, after, limit),
    },
    {
      name: 'refresh-token-cleanup',
      repeat: { pattern: '15 3 * * *' },
      bucketMs: DAY_MS,
      targetQueue: QUEUE_NAMES.REFRESH_TOKEN_CLEANUP,
      organizationIds: (_now, after, limit) => work.allActive(after, limit),
    },
    {
      name: 'notification-retention',
      repeat: { pattern: '30 3 * * *' },
      bucketMs: DAY_MS,
      targetQueue: QUEUE_NAMES.NOTIFICATION_RETENTION,
      organizationIds: (_now, after, limit) => work.allActive(after, limit),
    },
  ];
}

// Organizations fetched per query, and the most pages one sweep walks (a safety valve: 10,000
// organizations per tick; the next tick starts again from the beginning, and organizations that
// were served no longer match).
export const SWEEP_PAGE_SIZE = 500;
export const SWEEP_MAX_PAGES = 20;
