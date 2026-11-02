// Polls `probe` until it returns a value (not undefined/null/false), for tests that wait on an
// asynchronous worker. Fails with the last error or a timeout instead of hanging.
export async function waitFor<T>(
  probe: () => Promise<T | undefined | null | false>,
  timeoutMs = 15_000,
  intervalMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
