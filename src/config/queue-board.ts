// Whether Bull Board is mounted. It has no authentication and shows every organization's job
// payloads, so it needs BOTH an explicit opt-in and a non-production environment. Production plus
// the flag never gets here: the env schema refuses to start (fail fast), so this second check only
// guards the module graph, which is built before the validated config is injectable.
// Reads the raw environment on purpose: the module list of AppModule is decided at import time.
export function isQueueBoardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.QUEUE_BOARD_ENABLED === 'true' && env.NODE_ENV !== 'production';
}
