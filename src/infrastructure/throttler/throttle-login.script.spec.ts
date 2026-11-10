import { THROTTLE_LOGIN_SCRIPT } from './throttle-login.script';

// The safety rules of the login script, checked on its source so that a refactor cannot quietly break
// them. What it DOES is proven against a real Redis (integration spec); this guards the shape:
// no write before the checks, and a rejected request writes nothing at all.
const WRITES =
  /redis\.call\(\s*'(ZADD|ZREM|ZREMRANGEBYSCORE|ZINCRBY|PEXPIRE|EXPIRE|SET|DEL|UNLINK|HSET|INCR)'/;
const [beforeAdmit, admit] = THROTTLE_LOGIN_SCRIPT.split('-- 3. ADMIT (the only writes)');

describe('login script: write ordering', () => {
  it('has a clearly marked admit phase', () => {
    expect(admit).toBeDefined();
    expect(THROTTLE_LOGIN_SCRIPT).toContain('-- 1. VALIDATE (no writes)');
    expect(THROTTLE_LOGIN_SCRIPT).toContain('-- 2. DECIDE (reads only)');
  });

  it('performs NO write command before the admit phase (validation and the decision only read)', () => {
    expect(beforeAdmit).not.toMatch(WRITES);
  });

  it('ZREMRANGEBYSCORE, a write, appears only after the decision', () => {
    expect(beforeAdmit).not.toContain('ZREMRANGEBYSCORE');
    expect(admit).toContain('ZREMRANGEBYSCORE');
  });

  it('counts live hits with read-only commands', () => {
    expect(beforeAdmit).toContain("'ZCOUNT'");
    expect(beforeAdmit).toContain("'ZRANGEBYSCORE'");
  });

  it('checks every argument and both key types before anything else happens', () => {
    const typeCheck = beforeAdmit.indexOf("redis.call('TYPE'");
    const time = beforeAdmit.indexOf("redis.call('TIME')");
    const firstDecision = beforeAdmit.indexOf('local ipCount');
    expect(typeCheck).toBeGreaterThan(-1);
    expect(typeCheck).toBeLessThan(time);
    expect(time).toBeLessThan(firstDecision);
    for (const argument of [
      'invalid ttl',
      'invalid ip limit',
      'invalid account limit',
      'invalid member',
    ]) {
      expect(beforeAdmit.indexOf(argument)).toBeLessThan(time);
    }
    expect(beforeAdmit).toContain('WRONGTYPE');
  });

  it('the IP is decided before the account, and both blocked branches return without writing', () => {
    const ipDecision = beforeAdmit.indexOf('if ipCount >= ipLimit');
    const accountDecision = beforeAdmit.indexOf('if accountCount >= accountLimit');
    expect(ipDecision).toBeGreaterThan(-1);
    expect(ipDecision).toBeLessThan(accountDecision);
    expect(beforeAdmit).toMatch(/return \{ 1, ipCount \+ 1, wait, wait \}/);
    expect(beforeAdmit).toMatch(/return \{ 2, accountCount \+ 1, wait, wait \}/);
  });

  it('writes only the two keys it was given, adds the same hit to both and renews both TTLs', () => {
    expect(admit).toContain("redis.call('ZADD', KEYS[1], now + ttl, member)");
    expect(admit).toContain("redis.call('ZADD', KEYS[2], now + ttl, member)");
    expect(admit).toContain("redis.call('PEXPIRE', KEYS[1], ttl)");
    expect(admit).toContain("redis.call('PEXPIRE', KEYS[2], ttl)");
    expect(THROTTLE_LOGIN_SCRIPT).not.toMatch(/KEYS\[3\]/);
  });

  it('takes its time from Redis and takes no time argument', () => {
    expect(THROTTLE_LOGIN_SCRIPT).toContain("redis.call('TIME')");
    expect(THROTTLE_LOGIN_SCRIPT).not.toMatch(/ARGV\[5\]/);
  });
});
