import type { PoolConfig } from 'pg';
import { DatabaseConfig } from '../../config/app.config';

// The pool and timeout settings in one place so a unit test can pin them (ADR 0016).
export function buildPoolConfig(connectionString: string, database: DatabaseConfig): PoolConfig {
  return {
    connectionString,
    max: database.poolMax,
    // Without this pg waits forever for a free connection.
    connectionTimeoutMillis: database.acquireTimeoutMs,
    // Sent to PostgreSQL as session settings, so they also bound a statement that is stuck waiting
    // for a lock.
    statement_timeout: database.statementTimeoutMs,
    idle_in_transaction_session_timeout: database.idleInTransactionTimeoutMs,
  };
}

// Defaults for every `$transaction(async (tx) => ...)`; a call that needs more passes its own
// (the audit retention job does).
export function buildTransactionOptions(database: DatabaseConfig): {
  maxWait: number;
  timeout: number;
} {
  return { maxWait: database.acquireTimeoutMs, timeout: database.transactionTimeoutMs };
}
