import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

// Fire and forget, for AFTER the commit: the work the event announces has already happened. A
// listener that throws (synchronously or by rejecting) is caught and logged with the subject's id
// and never reaches the caller. In-process only: if the process dies between the commit and this
// call the event is lost (Phase 12, queue / outbox, closes that; ADR 0009).
export function publishDomainEvent(
  emitter: Pick<EventEmitter2, 'emitAsync'>,
  logger: Logger,
  name: string,
  payload: object,
  subject: string,
): void {
  const failed = (error: unknown) =>
    logger.error(`A ${name} listener failed (${subject}): ${String(error)}`);
  try {
    emitter.emitAsync(name, payload).catch(failed);
  } catch (error) {
    failed(error);
  }
}
