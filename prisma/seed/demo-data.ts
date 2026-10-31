import * as argon2 from 'argon2';
import { ROLE_NAMES } from './permissions';
import type { PrismaClient } from './prisma-client';

export const DEMO_MANAGER_EMAIL = 'manager@example.com';
export const DEMO_REP_EMAIL = 'rep@example.com';

// Small data set to exercise the schema and the first endpoints. Only runs with SEED_DEMO_DATA=true.
// Guarded by "org already has companies", so a second run changes nothing.
export async function seedDemoData(
  prisma: PrismaClient,
  { organizationId, password }: { organizationId: string; password: string },
): Promise<boolean> {
  if ((await prisma.company.count({ where: { organizationId } })) > 0) return false;

  const roles = await prisma.role.findMany({ where: { organizationId } });
  const roleId = (name: string) => roles.find((role) => role.name === name)?.id as string;
  const passwordHash = await argon2.hash(password);

  const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
  const pipeline = await prisma.pipeline.findFirstOrThrow({
    where: { organizationId, isDefault: true },
    include: { stages: { orderBy: { position: 'asc' } } },
  });
  const [prospecting, qualified, proposal] = pipeline.stages;

  await prisma.$transaction(async (tx) => {
    const manager = await tx.user.create({
      data: {
        organizationId,
        roleId: roleId(ROLE_NAMES.SALES_MANAGER),
        email: DEMO_MANAGER_EMAIL,
        passwordHash,
        firstName: 'Mona',
        lastName: 'Manager',
      },
    });
    const rep = await tx.user.create({
      data: {
        organizationId,
        roleId: roleId(ROLE_NAMES.SALES_REP),
        managerId: manager.id,
        email: DEMO_REP_EMAIL,
        passwordHash,
        firstName: 'Ravi',
        lastName: 'Rep',
      },
    });

    const acme = await tx.company.create({
      data: {
        organizationId,
        ownerId: rep.id,
        name: 'Acme Corp',
        domain: 'acme.example',
        industry: 'Manufacturing',
      },
    });
    const globex = await tx.company.create({
      data: {
        organizationId,
        ownerId: manager.id,
        name: 'Globex',
        domain: 'globex.example',
        industry: 'Software',
      },
    });
    const alice = await tx.contact.create({
      data: {
        organizationId,
        ownerId: rep.id,
        companyId: acme.id,
        firstName: 'Alice',
        lastName: 'Adams',
        email: 'alice@acme.example',
        jobTitle: 'Purchasing Lead',
      },
    });
    const bob = await tx.contact.create({
      data: {
        organizationId,
        ownerId: manager.id,
        companyId: globex.id,
        firstName: 'Bob',
        lastName: 'Baker',
        email: 'bob@globex.example',
        jobTitle: 'CTO',
      },
    });

    await tx.lead.createMany({
      data: [
        {
          organizationId,
          ownerId: rep.id,
          firstName: 'Carla',
          lastName: 'Cruz',
          email: 'carla@initech.example',
          companyName: 'Initech',
          source: 'WEBSITE',
          status: 'NEW',
          score: 20,
        },
        {
          organizationId,
          ownerId: rep.id,
          firstName: 'Dan',
          lastName: 'Diaz',
          email: 'dan@umbrella.example',
          companyName: 'Umbrella',
          source: 'REFERRAL',
          status: 'QUALIFIED',
          score: 70,
        },
        {
          organizationId,
          ownerId: manager.id,
          firstName: 'Eve',
          lastName: 'Evans',
          source: 'COLD_CALL',
          status: 'CONTACTED',
          score: 40,
        },
      ],
    });

    const deals = [
      {
        ownerId: rep.id,
        contactId: alice.id,
        companyId: acme.id,
        title: 'Acme annual license',
        amount: 25000,
        stageId: qualified.id,
      },
      {
        ownerId: manager.id,
        contactId: bob.id,
        companyId: globex.id,
        title: 'Globex platform rollout',
        amount: 80000,
        stageId: proposal.id,
      },
    ];
    for (const deal of deals) {
      await tx.deal.create({
        data: {
          ...deal,
          organizationId,
          pipelineId: pipeline.id,
          currency: org.defaultCurrency,
          // Every deal starts in the first stage, then moves to its current one.
          // organizationId is inherited from the deal through the composite FK.
          stageHistory: {
            create: [
              { toStageId: prospecting.id, changedById: deal.ownerId },
              {
                fromStageId: prospecting.id,
                toStageId: deal.stageId,
                changedById: deal.ownerId,
              },
            ],
          },
        },
      });
    }
  });
  return true;
}
