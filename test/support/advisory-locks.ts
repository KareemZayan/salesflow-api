import type { PrismaClient } from '../../prisma/seed/prisma-client';
import {
  acquireLock,
  type LockKind,
  type LockMode,
} from '../../src/infrastructure/prisma/advisory-lock';

// Holds an advisory lock in an open transaction until `release()` is called, so a test can prove
// that a request WAITS for that lock (or, just as important, does not).
export async function holdLock(
  prisma: PrismaClient,
  kind: LockKind,
  id: string,
  mode: LockMode = 'exclusive',
) {
  let release!: () => void;
  let acquired!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const held = new Promise<void>((resolve) => (acquired = resolve));
  const done = prisma.$transaction(
    async (tx) => {
      await acquireLock(tx, kind, id, mode);
      acquired();
      await gate;
    },
    { timeout: 30_000 },
  );
  await held;
  return { release: () => release(), done };
}

// True when `promise` has not settled after `ms`: "the request is waiting on something".
export async function stillPendingAfter(promise: PromiseLike<unknown>, ms = 600): Promise<boolean> {
  let settled = false;
  void Promise.resolve(promise).then(() => (settled = true));
  await new Promise((resolve) => setTimeout(resolve, ms));
  return !settled;
}
