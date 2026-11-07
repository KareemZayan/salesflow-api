import { Logger } from '@nestjs/common';

// For producers that run AFTER the business transaction has committed (event listeners): a Redis
// outage is logged and swallowed rather than failing a request whose write already succeeded. The
// queued work is then LOST (no outbox yet; ADR 0011). `what` names the job for the log and must
// carry ids or keys only, never the content.
export async function enqueueBestEffort(
  logger: Logger,
  what: string,
  enqueue: () => Promise<void>,
): Promise<void> {
  try {
    await enqueue();
  } catch (error) {
    logger.error(
      `Could not enqueue ${what}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
