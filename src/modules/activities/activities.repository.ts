import { Inject, Injectable } from '@nestjs/common';
import { TenantPrismaClient } from '../../common/tenant/tenant-scope.extension';
import { KeysetPosition } from '../../common/utils/keyset-cursor.util';
import { isForeignKeyViolation } from '../../common/utils/prisma-error.util';
import { ActivityType, Prisma } from '../../generated/prisma/client';
import { PRISMA_TENANT } from '../../infrastructure/prisma/prisma.constants';
import { MANUAL_ACTIVITY_TYPES } from './activities.constants';
import { CreateActivityJob } from './activity-job';
import { ActivityParent, parentLink } from './activity-parent';

// An explicit select: the response shape is decided here, never by whatever the table gains later.
const activitySelect = {
  id: true,
  type: true,
  subject: true,
  body: true,
  metadata: true,
  occurredAt: true,
  actorId: true,
  leadId: true,
  dealId: true,
  contactId: true,
  companyId: true,
  createdAt: true,
} satisfies Prisma.ActivitySelect;

export type ActivityRecord = Prisma.ActivityGetPayload<{ select: typeof activitySelect }>;

export interface NewManualActivity {
  organizationId: string;
  actorId: string;
  type: ActivityType;
  subject: string;
  body?: string;
  parent: ActivityParent;
}

// created: written now. duplicate: this dedupeKey already produced an entry (a retry or a second
// delivery). unknownTarget: the record (or actor) does not exist in this organization.
export type CreateOutcome = 'created' | 'duplicate' | 'unknownTarget';

// Every method runs on the tenant-scoped client, so the organization filter is never hand-written.
@Injectable()
export class ActivitiesRepository {
  constructor(@Inject(PRISMA_TENANT) private readonly prisma: TenantPrismaClient) {}

  // Newest first, `occurredAt` then `id` (keyset: stable under inserts, constant cost per page; the
  // (organizationId, <link>, occurredAt DESC, id) indexes serve it). Returns `take` rows so the
  // caller can tell whether another page exists.
  findPage(parent: ActivityParent, after: KeysetPosition | undefined, take: number) {
    return this.prisma.activity.findMany({
      where: {
        ...parentLink(parent),
        ...(after && {
          OR: [{ occurredAt: { lt: after.at } }, { occurredAt: after.at, id: { lt: after.id } }],
        }),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take,
      select: activitySelect,
    });
  }

  createManual({ parent, ...data }: NewManualActivity): Promise<ActivityRecord> {
    return this.prisma.activity.create({
      data: { ...data, ...parentLink(parent) },
      select: activitySelect,
    });
  }

  findOne(id: string): Promise<ActivityRecord | null> {
    return this.prisma.activity.findFirst({ where: { id }, select: activitySelect });
  }

  // The guard is in the same statement as the delete: only a MANUAL entry, and (for a non-admin)
  // only the author's. 0 = it vanished or stopped matching since the caller looked.
  async deleteManual(id: string, onlyAuthoredBy?: string): Promise<boolean> {
    const { count } = await this.prisma.activity.deleteMany({
      where: {
        id,
        type: { in: [...MANUAL_ACTIVITY_TYPES] },
        ...(onlyAuthoredBy && { actorId: onlyAuthoredBy }),
      },
    });
    return count === 1;
  }

  // ON CONFLICT DO NOTHING on (organizationId, dedupeKey): two workers racing on the same job both
  // run this and exactly one inserts. The composite foreign keys (<link>, organizationId) are what
  // reject a target from another organization or one that does not exist.
  async createIfAbsent(job: CreateActivityJob): Promise<CreateOutcome> {
    try {
      const { count } = await this.prisma.activity.createMany({
        data: [
          {
            organizationId: job.organizationId,
            actorId: job.actorId,
            type: job.type,
            subject: job.subject,
            metadata: job.metadata,
            occurredAt: new Date(job.occurredAt),
            dedupeKey: job.dedupeKey,
            ...parentLink(job.target),
          },
        ],
        skipDuplicates: true,
      });
      return count === 1 ? 'created' : 'duplicate';
    } catch (error) {
      if (isForeignKeyViolation(error)) return 'unknownTarget';
      throw error;
    }
  }
}
