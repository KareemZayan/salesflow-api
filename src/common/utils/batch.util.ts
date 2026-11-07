// One step of a batched clean-up: how many rows it removed, and whether nothing more is waiting.
export interface BatchResult {
  removed: number;
  exhausted: boolean;
}

// Runs `step` until it reports nothing left or `maxBatches` steps have run, and returns the total
// removed. The cap bounds ONE job run: whatever is left is taken by the next scheduled run, so a
// huge backlog never holds a worker (or a database lock) for long.
export async function runInBatches(
  step: () => Promise<BatchResult>,
  maxBatches: number,
): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const { removed, exhausted } = await step();
    total += removed;
    if (exhausted) break;
  }
  return total;
}
