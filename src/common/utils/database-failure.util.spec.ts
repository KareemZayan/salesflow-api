import { Prisma } from '../../generated/prisma/client';
import { classifyDatabaseFailure } from './database-failure.util';

// Fixtures copy the shapes observed against PostgreSQL 16 in
// test/integration/prisma-failures.integration-spec.ts, which is what keeps them honest.
const known = (code: string, meta?: Record<string, unknown>, message = 'driver detail') =>
  new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: 'test', meta });
const cause = (originalCode: string) => ({ driverAdapterError: { cause: { originalCode } } });

describe('classifyDatabaseFailure', () => {
  it.each([
    ['P2010', '40P01', 'WRITE_CONFLICT'],
    ['P2034', '40P01', 'WRITE_CONFLICT'],
    ['P2034', '40001', 'WRITE_CONFLICT'],
    ['P2010', '57014', 'TIMEOUT'],
    ['P2039', '57014', 'TIMEOUT'],
    ['P2039', '55P03', 'TIMEOUT'],
  ])('reads the SQLSTATE under %s / %s as %s', (code, sqlState, expected) => {
    expect(classifyDatabaseFailure(known(code, cause(sqlState)))).toBe(expected);
  });

  it('treats P2034 as a write conflict even without driver detail', () => {
    expect(classifyDatabaseFailure(known('P2034'))).toBe('WRITE_CONFLICT');
  });

  it('reads an unreachable database (P1001) as UNAVAILABLE', () => {
    expect(classifyDatabaseFailure(known('P1001'))).toBe('UNAVAILABLE');
  });

  // The shapes below were observed against a dead database (probe in ADR 0016). A host name that
  // resolves to several addresses (`localhost` = ::1 + 127.0.0.1) fails differently from one that
  // resolves to a single address, and differently per call path.
  describe('unreachable database: a host with SEVERAL addresses (3 shapes) and a single address (1)', () => {
    it('several addresses, MODEL query: PrismaClientKnownRequestError, code ECONNREFUSED, meta { modelName }', () => {
      const error = new Prisma.PrismaClientKnownRequestError('', {
        code: 'ECONNREFUSED',
        clientVersion: 'test',
        meta: { modelName: 'User' },
      });

      expect(error.code).toBe('ECONNREFUSED');
      expect(error.meta).toEqual({ modelName: 'User' });
      expect(classifyDatabaseFailure(error)).toBe('UNAVAILABLE');
    });

    it('several addresses, RAW query: PrismaClientKnownRequestError, code ECONNREFUSED, NO meta at all', () => {
      const error = new Prisma.PrismaClientKnownRequestError('', {
        code: 'ECONNREFUSED',
        clientVersion: 'test',
      });

      expect(error.code).toBe('ECONNREFUSED');
      expect(error.meta).toBeUndefined();
      expect(classifyDatabaseFailure(error)).toBe('UNAVAILABLE');
    });

    it('several addresses, TRANSACTION START: a bare AggregateError (not a Prisma error), code ECONNREFUSED, empty message', () => {
      const error = Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' });

      expect(error).not.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect(error.message).toBe('');
      expect(classifyDatabaseFailure(error)).toBe('UNAVAILABLE');
    });

    it('SINGLE address, RAW query (not a several-address shape): P2010, cause kind DatabaseNotReachable, no SQLSTATE', () => {
      const error = known('P2010', {
        driverAdapterError: { cause: { kind: 'DatabaseNotReachable', host: '127.0.0.1', port: 1 } },
      });

      expect(error.code).toBe('P2010');
      const { cause } = (error.meta as { driverAdapterError: { cause: Record<string, unknown> } })
        .driverAdapterError;
      expect(cause.originalCode).toBeUndefined();
      expect(classifyDatabaseFailure(error)).toBe('UNAVAILABLE');
    });

    it('an AggregateError with any other code, or none, is left alone', () => {
      expect(classifyDatabaseFailure(new AggregateError([], 'x'))).toBeNull();
      const other = Object.assign(new AggregateError([], ''), { code: 'EACCES' });
      expect(classifyDatabaseFailure(other)).toBeNull();
    });
  });

  describe('P2028 is several different problems', () => {
    it('an expired transaction (meta.timeout) is a TIMEOUT', () => {
      const expired = known('P2028', { operation: 'query', timeout: 200, timeTaken: 608 });
      expect(classifyDatabaseFailure(expired)).toBe('TIMEOUT');
    });

    it('a transaction that could not start in time is BUSY', () => {
      const busy = known(
        'P2028',
        {},
        'Transaction API error: Unable to start a transaction in the given time.',
      );
      expect(classifyDatabaseFailure(busy)).toBe('BUSY');
    });

    it('an already-closed transaction client is a code bug and is NOT classified', () => {
      const closed = known(
        'P2028',
        {},
        'Transaction API error: Transaction already closed: A query cannot be executed on a committed transaction.',
      );
      expect(classifyDatabaseFailure(closed)).toBeNull();
    });
  });

  describe('plain pg errors', () => {
    it('an exhausted pool is BUSY', () => {
      expect(classifyDatabaseFailure(new Error('timeout exceeded when trying to connect'))).toBe(
        'BUSY',
      );
    });

    it('a lost connection is UNAVAILABLE', () => {
      expect(
        classifyDatabaseFailure(
          new Error('Client has encountered a connection error and is not queryable'),
        ),
      ).toBe('UNAVAILABLE');
    });

    it('matches the whole message, not a fragment', () => {
      expect(
        classifyDatabaseFailure(new Error('timeout exceeded when trying to connect x')),
      ).toBeNull();
    });
  });

  it.each([
    ['unique violation', known('P2002')],
    ['record not found', known('P2025')],
    ['foreign key', known('P2003')],
    ['unobserved pool timeout code', known('P2024')],
    ['unobserved connection codes', known('P1002')],
    ['an unknown SQLSTATE', known('P2010', cause('23505'))],
    ['a generic error', new Error('boom')],
    ['a string', 'timeout exceeded when trying to connect'],
    ['undefined', undefined],
  ])('leaves %s alone', (_label, error) => {
    expect(classifyDatabaseFailure(error)).toBeNull();
  });
});
