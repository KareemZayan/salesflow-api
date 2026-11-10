import { PrismaPg } from '@prisma/adapter-pg';
import type { PoolConfig } from 'pg';
import { classifyDatabaseFailure } from '../../src/common/utils/database-failure.util';
import { Prisma, PrismaClient } from '../../src/generated/prisma/client';
import { assertTestDatabase } from '../setup/test-database';

// ADR 0016. Provokes every database failure the API has to answer, against a real PostgreSQL, and
// pins (1) the exact error Prisma 7 + the pg adapter throw and how classifyDatabaseFailure reads it,
// (2) that a failed transaction gives its connection and its locks back. If a driver upgrade changes
// an error shape, this file fails instead of the API silently answering 500.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function caught(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error('expected the operation to fail');
}

const prismaCode = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError ? error.code : undefined;

describe('database failure modes (integration)', () => {
  const url = assertTestDatabase(process.env.TEST_DATABASE_URL);
  const created: PrismaClient[] = [];
  const slugs: string[] = [];
  let seq = 0;

  const client = (pool: Partial<PoolConfig> = {}, transactionOptions?: object) => {
    const prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url, ...pool }),
      ...(transactionOptions && { transactionOptions }),
    });
    created.push(prisma);
    return prisma;
  };
  // Unique, and remembered so afterAll removes whatever a test left behind.
  const trackedSlug = (prefix: string) => {
    const slug = `${prefix}-${process.pid}-${Date.now()}-${seq++}`;
    slugs.push(slug);
    return slug;
  };
  const organization = async (prisma: PrismaClient) => {
    const slug = trackedSlug('fail');
    return prisma.organization.create({ data: { name: slug, slug } });
  };
  // Another connection answering: "is this advisory lock free?" (the same key a leaked lock would hold)
  const lockIsFree = async (prisma: PrismaClient, key: number) =>
    prisma.$transaction(async (tx) => {
      const [{ ok }] = await tx.$queryRaw<{ ok: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(${key}) AS ok`;
      return ok;
    });
  const idleInTransaction = async (prisma: PrismaClient) =>
    (
      await prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND state LIKE 'idle in transaction%'`
    )[0].n;

  afterAll(async () => {
    const cleaner = client();
    await cleaner.organization.deleteMany({ where: { slug: { in: slugs } } });
    await Promise.all(created.map((prisma) => prisma.$disconnect()));
  });

  describe('what is thrown, and how it is classified', () => {
    it('pool exhausted: a plain pg Error, not a Prisma error -> BUSY', async () => {
      const prisma = client({ max: 1, connectionTimeoutMillis: 300 });
      await prisma.$queryRaw`SELECT 1`;
      const holder = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1`;
        await sleep(1200);
      });
      await sleep(100);

      const error = await caught(() => prisma.$queryRaw`SELECT 2`);

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((error as Error).message).toBe('timeout exceeded when trying to connect');
      expect(classifyDatabaseFailure(error)).toBe('BUSY');
      await holder;
    });

    it('transaction cannot start in time (maxWait): P2028 with empty meta -> BUSY', async () => {
      const prisma = client({ max: 1 });
      await prisma.$queryRaw`SELECT 1`;
      const holder = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1`;
        await sleep(1200);
      });
      await sleep(100);

      const error = await caught(() =>
        prisma.$transaction(async (tx) => tx.$queryRaw`SELECT 2`, { maxWait: 300 }),
      );

      expect(prismaCode(error)).toBe('P2028');
      expect((error as Prisma.PrismaClientKnownRequestError).meta).toEqual({});
      expect(classifyDatabaseFailure(error)).toBe('BUSY');
      await holder;
    });

    it('transaction expired (query or commit after the limit): P2028 with meta.timeout -> TIMEOUT, and rolled back', async () => {
      const prisma = client();
      const afterQuery = await caught(() =>
        prisma.$transaction(
          async (tx) => {
            await tx.organization.create({
              data: { name: 'rolled-back', slug: trackedSlug('expired-q') },
            });
            await sleep(600);
            await tx.$queryRaw`SELECT 1`;
          },
          { timeout: 200 },
        ),
      );
      const atCommit = await caught(() =>
        prisma.$transaction(
          async (tx) => {
            await tx.organization.create({
              data: { name: 'rolled-back', slug: trackedSlug('expired-c') },
            });
            await sleep(600);
          },
          { timeout: 200 },
        ),
      );

      for (const error of [afterQuery, atCommit]) {
        expect(prismaCode(error)).toBe('P2028');
        expect(typeof (error as Prisma.PrismaClientKnownRequestError).meta?.timeout).toBe('number');
        expect(classifyDatabaseFailure(error)).toBe('TIMEOUT');
      }
      // Nothing of either transaction survived, the commit-time expiry included.
      expect(await prisma.organization.count({ where: { name: 'rolled-back' } })).toBe(0);
    });

    it('a leaked, already-closed transaction client is a code bug: P2028 but NOT classified', async () => {
      const prisma = client();
      let leaked: { $queryRaw: PrismaClient['$queryRaw'] } | undefined;
      await prisma.$transaction(async (tx) => {
        leaked = tx;
      });

      const error = await caught(async () => leaked!.$queryRaw`SELECT 1`);

      expect(prismaCode(error)).toBe('P2028');
      expect((error as Error).message).toContain('Transaction already closed');
      expect(classifyDatabaseFailure(error)).toBeNull();
    });

    it('statement_timeout: P2010 on raw queries, P2039 on model queries, same SQLSTATE -> TIMEOUT', async () => {
      const holderClient = client();
      const row = await organization(holderClient);
      const prisma = client({ statement_timeout: 250 });
      const holder = holderClient.$transaction(async (tx) => {
        await tx.organization.update({ where: { id: row.id }, data: { name: 'held' } });
        await sleep(1200);
      });
      await sleep(200);

      const raw = await caught(() => prisma.$queryRaw`SELECT pg_sleep(2)`);
      const model = await caught(() =>
        prisma.organization.update({ where: { id: row.id }, data: { name: 'x' } }),
      );

      expect(prismaCode(raw)).toBe('P2010');
      expect(prismaCode(model)).toBe('P2039');
      expect(classifyDatabaseFailure(raw)).toBe('TIMEOUT');
      expect(classifyDatabaseFailure(model)).toBe('TIMEOUT');
      await holder;
    });

    it('lock_timeout on a model query: P2039 / 55P03 -> TIMEOUT', async () => {
      const holderClient = client();
      const row = await organization(holderClient);
      const prisma = client({ options: '-c lock_timeout=250' } as Partial<PoolConfig>);
      const holder = holderClient.$transaction(async (tx) => {
        await tx.organization.update({ where: { id: row.id }, data: { name: 'held' } });
        await sleep(1200);
      });
      await sleep(200);

      const error = await caught(() =>
        prisma.organization.update({ where: { id: row.id }, data: { name: 'x' } }),
      );

      expect(classifyDatabaseFailure(error)).toBe('TIMEOUT');
      await holder;
    });

    it('deadlock: P2010 (raw, 40P01) and P2034 (model) both -> WRITE_CONFLICT', async () => {
      const prisma = client();
      const raw = (first: number, second: number) =>
        prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${first})`;
          await sleep(400);
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${second})`;
        });
      const rawResults = await Promise.allSettled([raw(910001, 910002), raw(910002, 910001)]);

      const a = await organization(prisma);
      const b = await organization(prisma);
      const model = (first: string, second: string) =>
        prisma.$transaction(async (tx) => {
          await tx.organization.update({ where: { id: first }, data: { name: 'x' } });
          await sleep(400);
          await tx.organization.update({ where: { id: second }, data: { name: 'y' } });
        });
      const modelResults = await Promise.allSettled([model(a.id, b.id), model(b.id, a.id)]);

      const rawVictim = rawResults.find((r) => r.status === 'rejected');
      const modelVictim = modelResults.find((r) => r.status === 'rejected');
      expect(rawResults.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(modelResults.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(prismaCode((rawVictim as PromiseRejectedResult).reason)).toBe('P2010');
      expect(prismaCode((modelVictim as PromiseRejectedResult).reason)).toBe('P2034');
      expect(classifyDatabaseFailure((rawVictim as PromiseRejectedResult).reason)).toBe(
        'WRITE_CONFLICT',
      );
      expect(classifyDatabaseFailure((modelVictim as PromiseRejectedResult).reason)).toBe(
        'WRITE_CONFLICT',
      );
    });

    it('serialization failure (40001): P2034 -> WRITE_CONFLICT', async () => {
      const prisma = client();
      const row = await organization(prisma);
      const run = () =>
        prisma.$transaction(
          async (tx) => {
            await tx.organization.findMany({ where: { id: row.id } });
            await sleep(300);
            await tx.organization.update({
              where: { id: row.id },
              data: { name: `n${Math.random()}` },
            });
          },
          { isolationLevel: 'Serializable' },
        );

      const results = await Promise.allSettled([run(), run()]);

      const victim = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(prismaCode(victim.reason)).toBe('P2034');
      expect(classifyDatabaseFailure(victim.reason)).toBe('WRITE_CONFLICT');
    });

    it('database unreachable: P1001 -> UNAVAILABLE', async () => {
      const dead = client({
        connectionString: 'postgresql://nobody:none@127.0.0.1:1/none',
        connectionTimeoutMillis: 500,
      });

      const error = await caught(() => dead.organization.findMany());

      expect(prismaCode(error)).toBe('P1001');
      expect(classifyDatabaseFailure(error)).toBe('UNAVAILABLE');
    });

    it('database unreachable, every call path: raw query is P2010 with a DatabaseNotReachable cause -> UNAVAILABLE', async () => {
      const dead = client({
        connectionString: 'postgresql://nobody:none@127.0.0.1:1/none',
        connectionTimeoutMillis: 500,
      });

      const raw = await caught(() => dead.$queryRaw`SELECT 1`);
      const tx = await caught(() => dead.$transaction(async (t) => t.organization.findMany()));

      expect(prismaCode(raw)).toBe('P2010');
      expect(classifyDatabaseFailure(raw)).toBe('UNAVAILABLE');
      expect(classifyDatabaseFailure(tx)).toBe('UNAVAILABLE');
    });

    it('database unreachable behind a name with several addresses (localhost): ECONNREFUSED -> UNAVAILABLE', async () => {
      // `localhost` is ::1 and 127.0.0.1 on a dual-stack machine, where the refusal arrives as
      // ECONNREFUSED (a known-request code for model AND raw queries, a bare AggregateError when a
      // transaction starts). On a single-address machine it is P1001 / P2010. Either way: UNAVAILABLE.
      const dead = client({
        connectionString: 'postgresql://nobody:none@localhost:1/none',
        connectionTimeoutMillis: 500,
      });

      const model = await caught(() => dead.organization.findMany());
      const tx = await caught(() => dead.$transaction(async (t) => t.organization.findMany()));
      const raw = await caught(() => dead.$queryRaw`SELECT 1`);

      for (const error of [model, tx, raw]) {
        expect(classifyDatabaseFailure(error)).toBe('UNAVAILABLE');
      }
    });

    it('connection killed by the server mid-transaction: plain pg Error -> UNAVAILABLE, pool recovers', async () => {
      const prisma = client();
      const admin = client();

      const error = await caught(() =>
        prisma.$transaction(async (tx) => {
          const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          await admin.$queryRaw`SELECT pg_terminate_backend(${pid})`;
          await sleep(200);
          await tx.$queryRaw`SELECT 1`;
        }),
      );

      expect((error as Error).message).toBe(
        'Client has encountered a connection error and is not queryable',
      );
      expect(classifyDatabaseFailure(error)).toBe('UNAVAILABLE');
      await expect(prisma.$queryRaw`SELECT 1 AS ok`).resolves.toEqual([{ ok: 1 }]);
    });

    it('idle_in_transaction_session_timeout kills the connection the same way -> UNAVAILABLE', async () => {
      const prisma = client({ idle_in_transaction_session_timeout: 300 });

      const error = await caught(() =>
        prisma.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT 1`;
            await sleep(900);
            await tx.$queryRaw`SELECT 2`;
          },
          { timeout: 5000 },
        ),
      );

      expect(classifyDatabaseFailure(error)).toBe('UNAVAILABLE');
    });

    it('ordinary application errors are never classified', async () => {
      const prisma = client();
      const row = await organization(prisma);

      const duplicate = await caught(() =>
        prisma.organization.create({ data: { name: 'dup', slug: row.slug } }),
      );
      const missing = await caught(() =>
        prisma.organization.update({ where: { id: 'no-such-id' }, data: { name: 'x' } }),
      );

      expect(prismaCode(duplicate)).toBe('P2002');
      expect(prismaCode(missing)).toBe('P2025');
      expect(classifyDatabaseFailure(duplicate)).toBeNull();
      expect(classifyDatabaseFailure(missing)).toBeNull();
      expect(classifyDatabaseFailure(new Error('boom'))).toBeNull();
      expect(classifyDatabaseFailure('timeout exceeded when trying to connect')).toBeNull();
    });
  });

  // One pooled connection: if a failed transaction kept it, the very next query would time out.
  describe('a failed transaction gives its connection and its locks back', () => {
    const KEY = 920001;
    const tight = () => client({ max: 1, connectionTimeoutMillis: 1500 });

    it('after an expired transaction that holds an advisory lock', async () => {
      const prisma = tight();
      const observer = client();

      await caught(() =>
        prisma.$transaction(
          async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(${KEY})`;
            await sleep(600);
            await tx.$queryRaw`SELECT 1`;
          },
          { timeout: 200 },
        ),
      );

      await expect(prisma.$queryRaw`SELECT 1 AS ok`).resolves.toEqual([{ ok: 1 }]);
      expect(await lockIsFree(observer, KEY)).toBe(true);
      expect(await idleInTransaction(observer)).toBe(0);
    });

    it('after a statement timeout inside a transaction that holds a lock', async () => {
      const prisma = client({ max: 1, connectionTimeoutMillis: 1500, statement_timeout: 250 });
      const observer = client();

      const error = await caught(() =>
        prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${KEY})`;
          await tx.$queryRaw`SELECT pg_sleep(2)`;
        }),
      );

      expect(classifyDatabaseFailure(error)).toBe('TIMEOUT');
      await expect(prisma.$queryRaw`SELECT 1 AS ok`).resolves.toEqual([{ ok: 1 }]);
      expect(await lockIsFree(observer, KEY)).toBe(true);
      expect(await idleInTransaction(observer)).toBe(0);
    });

    it('after a deadlock victim', async () => {
      const prisma = client({ max: 2, connectionTimeoutMillis: 1500 });
      const observer = client();
      const run = (first: number, second: number) =>
        prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${first})`;
          await sleep(400);
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${second})`;
        });

      await Promise.allSettled([run(KEY, KEY + 1), run(KEY + 1, KEY)]);

      await expect(prisma.$queryRaw`SELECT 1 AS ok`).resolves.toEqual([{ ok: 1 }]);
      expect(await lockIsFree(observer, KEY)).toBe(true);
      expect(await lockIsFree(observer, KEY + 1)).toBe(true);
      expect(await idleInTransaction(observer)).toBe(0);
    });

    it('after the callback throws', async () => {
      const prisma = tight();
      const observer = client();

      await caught(() =>
        prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${KEY})`;
          throw new Error('application failure');
        }),
      );

      await expect(prisma.$queryRaw`SELECT 1 AS ok`).resolves.toEqual([{ ok: 1 }]);
      expect(await lockIsFree(observer, KEY)).toBe(true);
    });

    // The finding behind DB_STATEMENT_TIMEOUT_MS < DB_TRANSACTION_TIMEOUT_MS (ADR 0016): Prisma's
    // transaction timeout is enforced by the client and cannot interrupt a statement that is blocked
    // on a lock, so the connection stays occupied until the lock frees up. Only the server-side
    // statement_timeout cuts the wait short.
    describe('a transaction blocked waiting for a lock', () => {
      const blockedBehind = async (
        waiter: PrismaClient,
        transactionTimeoutMs: number,
        lockHeldMs: number,
      ) => {
        const holder = client().$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${KEY})`;
          await sleep(lockHeldMs);
        });
        await sleep(200);
        const startedAt = Date.now();
        const error = await caught(() =>
          waiter.$transaction(
            async (tx) => {
              await tx.$executeRaw`SELECT pg_advisory_xact_lock(${KEY})`;
            },
            { timeout: transactionTimeoutMs },
          ),
        );
        const failedAfterMs = Date.now() - startedAt;
        await waiter.$queryRaw`SELECT 1 AS ok`;
        const connectionBackAfterMs = Date.now() - startedAt;
        await holder;
        return { error, failedAfterMs, connectionBackAfterMs };
      };

      it('with only the transaction timeout, the connection is kept until the lock is released', async () => {
        const waiter = client({ max: 1, connectionTimeoutMillis: 5000 });

        const { error, failedAfterMs, connectionBackAfterMs } = await blockedBehind(
          waiter,
          300,
          2500,
        );

        expect(prismaCode(error)).toBe('P2028');
        expect(classifyDatabaseFailure(error)).toBe('TIMEOUT');
        // The 300 ms limit fired late: Prisma noticed only when the blocked statement returned.
        expect(failedAfterMs).toBeGreaterThan(1500);
        expect(connectionBackAfterMs).toBeGreaterThan(1500);
      });

      it('with a statement_timeout below the transaction timeout, it is cut short and the connection returns at once', async () => {
        const waiter = client({
          max: 1,
          connectionTimeoutMillis: 5000,
          statement_timeout: 400,
        });

        const { error, failedAfterMs, connectionBackAfterMs } = await blockedBehind(
          waiter,
          1000,
          2500,
        );

        expect(classifyDatabaseFailure(error)).toBe('TIMEOUT');
        expect(failedAfterMs).toBeLessThan(1200);
        expect(connectionBackAfterMs).toBeLessThan(1500);
        // The waiter never held the lock; once the holder commits nothing keeps it.
        expect(await lockIsFree(client(), KEY)).toBe(true);
      });
    });
  });
});
