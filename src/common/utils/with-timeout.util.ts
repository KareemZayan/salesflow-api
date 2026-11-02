// Rejects when `work` has not settled after `ms`. The underlying work is NOT cancelled (a promise
// cannot be); the caller only stops waiting for it. The timer is always cleared, so a fast
// success leaves nothing behind that could keep the process alive.
export async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
