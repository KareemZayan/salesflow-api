import { Prisma } from '../../generated/prisma/client';

// What a database failure means for the caller, decided from what Prisma 7 + the pg adapter were
// OBSERVED to throw against PostgreSQL 16 (test/integration/prisma-failures.integration-spec.ts pins
// every shape below, so a driver upgrade that changes one fails a test instead of turning into a 500).
//  - BUSY: no connection became free in time. Nothing ran; retry shortly.
//  - TIMEOUT: a transaction, statement or lock wait exceeded its limit. PostgreSQL rolled the work
//    back; the same request may take as long again, so there is no retry hint.
//  - WRITE_CONFLICT: deadlock or serialization failure. The transaction was rolled back and a retry
//    is expected to succeed.
//  - UNAVAILABLE: the database cannot be reached or the connection was lost.
export type DatabaseFailure = 'BUSY' | 'TIMEOUT' | 'WRITE_CONFLICT' | 'UNAVAILABLE';

// SQLSTATE values, found in `meta.driverAdapterError.cause.originalCode` under P2010 (raw queries),
// P2034 (deadlock / serialization) and P2039 (model queries): the Prisma code differs by call path,
// the SQLSTATE does not, so it is the signal to read.
const SQLSTATE_WRITE_CONFLICT: ReadonlySet<string> = new Set([
  '40P01', // deadlock_detected
  '40001', // serialization_failure
]);
const SQLSTATE_TIMEOUT: ReadonlySet<string> = new Set([
  '57014', // query_canceled (statement_timeout)
  '55P03', // lock_not_available (lock_timeout)
]);

// Not Prisma errors: the pg driver's own messages, thrown as plain `Error`.
const PG_POOL_TIMEOUT_MESSAGE = 'timeout exceeded when trying to connect';
const PG_CONNECTION_LOST_MESSAGE = 'Client has encountered a connection error and is not queryable';

// P2028 is shared by several unrelated problems. Only these two are infrastructure conditions;
// "Transaction already closed" (a leaked transaction client) is a programming error and stays a 500.
const PRISMA_TRANSACTION_START_TIMEOUT = 'Unable to start a transaction in the given time';

interface DriverCause {
  originalCode?: unknown;
  kind?: unknown;
}

function driverCause(error: Prisma.PrismaClientKnownRequestError): DriverCause | undefined {
  return (error.meta as { driverAdapterError?: { cause?: DriverCause } } | undefined)
    ?.driverAdapterError?.cause;
}

// A host that resolves to several addresses (`localhost` is ::1 and 127.0.0.1) is refused on each, and
// Node reports that as an AggregateError carrying this code. Prisma passes it through as the `code`
// of a known request error for model queries and does not wrap it at all when a transaction starts.
// A single address, or a DNS failure, arrives as P1001 instead.
const NODE_CONNECTION_REFUSED = 'ECONNREFUSED';

function classifyKnownRequest(error: Prisma.PrismaClientKnownRequestError): DatabaseFailure | null {
  const cause = driverCause(error);
  // Raw queries report an unreachable database as P2010 with this cause and no SQLSTATE.
  if (cause?.kind === 'DatabaseNotReachable') return 'UNAVAILABLE';
  const sqlState = typeof cause?.originalCode === 'string' ? cause.originalCode : undefined;
  if (sqlState && SQLSTATE_WRITE_CONFLICT.has(sqlState)) return 'WRITE_CONFLICT';
  if (sqlState && SQLSTATE_TIMEOUT.has(sqlState)) return 'TIMEOUT';

  switch (error.code) {
    case 'P2034':
      return 'WRITE_CONFLICT';
    case 'P1001':
    case NODE_CONNECTION_REFUSED:
      return 'UNAVAILABLE';
    case 'P2028':
      // An expired transaction reports its limit in `meta.timeout`.
      if (typeof (error.meta as { timeout?: unknown } | undefined)?.timeout === 'number') {
        return 'TIMEOUT';
      }
      return error.message.includes(PRISMA_TRANSACTION_START_TIMEOUT) ? 'BUSY' : null;
    default:
      return null;
  }
}

// Returns null for everything that is not a recognised infrastructure failure, so the caller keeps
// its existing handling (unobserved codes such as P2024, P1002, P1008 or P1017 are deliberately not
// guessed at).
export function classifyDatabaseFailure(error: unknown): DatabaseFailure | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError) return classifyKnownRequest(error);
  if (!(error instanceof Error)) return null;
  if (
    error instanceof AggregateError &&
    (error as { code?: unknown }).code === NODE_CONNECTION_REFUSED
  ) {
    return 'UNAVAILABLE';
  }
  if (error.message === PG_POOL_TIMEOUT_MESSAGE) return 'BUSY';
  if (error.message === PG_CONNECTION_LOST_MESSAGE) return 'UNAVAILABLE';
  return null;
}
