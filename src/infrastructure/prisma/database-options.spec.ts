import { DatabaseConfig } from '../../config/app.config';
import { buildPoolConfig, buildTransactionOptions } from './database-options';

const database: DatabaseConfig = {
  poolMax: 12,
  acquireTimeoutMs: 4000,
  transactionTimeoutMs: 9000,
  statementTimeoutMs: 6000,
  idleInTransactionTimeoutMs: 20000,
};

describe('database options', () => {
  it('turns every setting into the pool config pg understands', () => {
    expect(buildPoolConfig('postgresql://u:p@db/x', database)).toEqual({
      connectionString: 'postgresql://u:p@db/x',
      max: 12,
      connectionTimeoutMillis: 4000,
      statement_timeout: 6000,
      idle_in_transaction_session_timeout: 20000,
    });
  });

  it('never leaves the connection wait unbounded (pg waits forever by default)', () => {
    expect(
      buildPoolConfig('postgresql://u:p@db/x', database).connectionTimeoutMillis,
    ).toBeGreaterThan(0);
  });

  it('uses the pool wait as the transaction maxWait, so both answer 503 after the same time', () => {
    expect(buildTransactionOptions(database)).toEqual({ maxWait: 4000, timeout: 9000 });
  });
});
