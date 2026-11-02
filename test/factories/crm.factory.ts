import type { PrismaClient } from '../../prisma/seed/prisma-client';
import { buildStageRows, type OpenStageInput } from '../../src/common/policies/pipeline-policy';
import type {
  DealStatus,
  LeadSource,
  LeadStatus,
  TaskPriority,
  TaskStatus,
} from '../../src/generated/prisma/client';

let sequence = 0;

interface Owned {
  organizationId: string;
  ownerId: string;
}

// Rows are created with the unscoped client on purpose: tests must not depend on the module under
// test to arrange their data.
export function createCompany(
  prisma: PrismaClient,
  { organizationId, ownerId }: Owned,
  overrides: { name?: string; domain?: string; industry?: string; deletedAt?: Date } = {},
) {
  return prisma.company.create({
    data: { organizationId, ownerId, name: `Company ${++sequence}`, ...overrides },
  });
}

export function createContact(
  prisma: PrismaClient,
  { organizationId, ownerId }: Owned,
  overrides: { companyId?: string; firstName?: string; email?: string; deletedAt?: Date } = {},
) {
  return prisma.contact.create({
    data: {
      organizationId,
      ownerId,
      firstName: 'Contact',
      lastName: `No${++sequence}`,
      ...overrides,
    },
  });
}

export function createLead(
  prisma: PrismaClient,
  { organizationId, ownerId }: Owned,
  overrides: {
    firstName?: string;
    email?: string;
    phone?: string;
    companyName?: string;
    source?: LeadSource;
    status?: LeadStatus;
    score?: number;
    notes?: string;
    deletedAt?: Date;
  } = {},
) {
  return prisma.lead.create({
    data: {
      organizationId,
      ownerId,
      firstName: 'Lead',
      lastName: `No${++sequence}`,
      source: 'OTHER',
      ...overrides,
    },
  });
}

// Pipeline with the given open stages (default: two) plus the Won and Lost stages the server adds.
export function createPipeline(
  prisma: PrismaClient,
  { organizationId }: { organizationId: string },
  overrides: { name?: string; isDefault?: boolean; openStages?: OpenStageInput[] } = {},
) {
  return prisma.pipeline.create({
    data: {
      organizationId,
      name: overrides.name ?? `Pipeline ${++sequence}`,
      isDefault: overrides.isDefault ?? false,
      stages: {
        create: buildStageRows(
          overrides.openStages ?? [
            { name: 'First', probability: 10 },
            { name: 'Second', probability: 50 },
          ],
        ),
      },
    },
    include: { stages: { orderBy: { position: 'asc' } } },
  });
}

// The pipeline the organization was created with, stages in board order.
export function findDefaultPipeline(prisma: PrismaClient, organizationId: string) {
  return prisma.pipeline.findFirstOrThrow({
    where: { organizationId, isDefault: true },
    include: { stages: { orderBy: { position: 'asc' } } },
  });
}

export function createDeal(
  prisma: PrismaClient,
  { organizationId, ownerId }: Owned,
  placement: { pipelineId: string; stageId: string },
  overrides: {
    title?: string;
    amount?: string;
    currency?: string;
    status?: DealStatus;
    contactId?: string;
    companyId?: string;
    deletedAt?: Date;
  } = {},
) {
  return prisma.deal.create({
    data: {
      organizationId,
      ownerId,
      title: `Deal ${++sequence}`,
      currency: 'USD',
      ...placement,
      ...overrides,
    },
  });
}

export function createTask(
  prisma: PrismaClient,
  { organizationId, assigneeId }: { organizationId: string; assigneeId: string },
  overrides: {
    createdById?: string;
    title?: string;
    status?: TaskStatus;
    priority?: TaskPriority;
    dueDate?: Date;
    completedAt?: Date;
    reminderAt?: Date;
    reminderSentAt?: Date;
    leadId?: string;
    dealId?: string;
    contactId?: string;
    companyId?: string;
  } = {},
) {
  return prisma.task.create({
    data: {
      organizationId,
      assigneeId,
      createdById: assigneeId,
      title: `Task ${++sequence}`,
      ...overrides,
    },
  });
}
