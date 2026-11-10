import { authThrottleTracker, clientIp, loginThrottleTracker } from './throttle.util';

describe('authThrottleTracker', () => {
  it('keys on IP and normalized email', () => {
    expect(authThrottleTracker({ ip: '1.2.3.4', body: { email: '  Sales@Example.COM ' } })).toBe(
      '1.2.3.4|sales@example.com',
    );
  });

  it.each([
    ['a number', 42],
    ['an object', { not: 'a string' }],
    ['an array', ['a@b.c']],
    ['null', null],
    ['an empty string', '   '],
    ['missing', undefined],
  ])('falls back to the IP when email is %s', (_label, email) => {
    expect(authThrottleTracker({ ip: '1.2.3.4', body: { email } })).toBe('1.2.3.4');
  });

  it('survives a missing or non-object body and a missing ip', () => {
    expect(authThrottleTracker({ ip: '1.2.3.4' })).toBe('1.2.3.4');
    expect(authThrottleTracker({ ip: '1.2.3.4', body: 'text' })).toBe('1.2.3.4');
    expect(authThrottleTracker({ body: { email: 'a@b.c' } })).toBe('unknown|a@b.c');
  });

  it('caps very long emails so keys stay small', () => {
    const key = authThrottleTracker({ ip: 'ip', body: { email: 'a'.repeat(5000) } });
    expect(key.length).toBeLessThan(300);
  });
});

// The same /64 is the same client (ADR 0016, 15c.1). Addresses are only ever compared after this step.
describe('clientIp', () => {
  it('leaves IPv4 exactly as it is', () => {
    expect(clientIp({ ip: '203.0.113.5' })).toBe('203.0.113.5');
    expect(clientIp({ ip: '127.0.0.1' })).toBe('127.0.0.1');
  });

  it('reads an IPv4-mapped IPv6 address (what a dual-stack socket reports) as the IPv4 address', () => {
    expect(clientIp({ ip: '::ffff:203.0.113.5' })).toBe('203.0.113.5');
    expect(clientIp({ ip: '::ffff:127.0.0.1' })).toBe(clientIp({ ip: '127.0.0.1' }));
  });

  it('puts every address of one /64 in the same bucket', () => {
    const addresses = [
      '2001:db8:abcd:12::1',
      '2001:db8:abcd:12::2',
      '2001:db8:abcd:12:ffff:ffff:ffff:ffff',
      '2001:db8:abcd:12:1234:5678:9abc:def0',
    ];
    const buckets = new Set(addresses.map((ip) => clientIp({ ip })));
    expect(buckets).toEqual(new Set(['2001:db8:abcd:12::/64']));
  });

  it('keeps different /64s apart, down to the last bit of the prefix', () => {
    expect(clientIp({ ip: '2001:db8:abcd:12::1' })).not.toBe(
      clientIp({ ip: '2001:db8:abcd:13::1' }),
    );
    expect(clientIp({ ip: '2001:db8:abcd:12::1' })).not.toBe(
      clientIp({ ip: '2001:db8:abce:12::1' }),
    );
  });

  it('ignores an IPv6 zone id', () => {
    expect(clientIp({ ip: 'fe80::1%eth0' })).toBe(clientIp({ ip: 'fe80::2' }));
  });

  it('never produces a "|" (the separator of the login key) for any address form', () => {
    for (const ip of [
      '1.2.3.4',
      '::1',
      '::ffff:1.2.3.4',
      '2001:db8::1',
      'fe80::1%eth0',
      'garbage',
    ]) {
      expect(clientIp({ ip })).not.toContain('|');
    }
  });

  it.each([
    ['missing', {}],
    ['not a string', { ip: 42 }],
    ['empty', { ip: '' }],
  ])('is "unknown" when the address is %s', (_label, req) => {
    expect(clientIp(req)).toBe('unknown');
  });
});

describe('authThrottleTracker with IPv6 (refresh, change-password)', () => {
  it('uses the /64, and IPv4 results are unchanged', () => {
    expect(authThrottleTracker({ ip: '2001:db8:abcd:12::99' })).toBe('2001:db8:abcd:12::/64');
    expect(authThrottleTracker({ ip: '1.2.3.4' })).toBe('1.2.3.4');
  });
});

describe('loginThrottleTracker', () => {
  it('is always "<normalized ip>|<normalized email>"', () => {
    expect(loginThrottleTracker({ ip: '1.2.3.4', body: { email: '  Sales@Example.COM ' } })).toBe(
      '1.2.3.4|sales@example.com',
    );
  });

  it('normalizes the IPv6 address to its /64 and keeps the email', () => {
    expect(loginThrottleTracker({ ip: '2001:db8:abcd:12::1', body: { email: 'a@b.co' } })).toBe(
      '2001:db8:abcd:12::/64|a@b.co',
    );
  });

  it('two addresses of one /64 trying the same account share the key; another /64 does not', () => {
    const body = { email: 'victim@example.com' };
    const a = loginThrottleTracker({ ip: '2001:db8:abcd:12::1', body });
    const b = loginThrottleTracker({ ip: '2001:db8:abcd:12:ffff::9', body });
    const c = loginThrottleTracker({ ip: '2001:db8:abcd:13::1', body });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it.each([
    ['a number', 42],
    ['an object', { not: 'a string' }],
    ['an array', ['a@b.c']],
    ['null', null],
    ['an empty string', '   '],
    ['missing', undefined],
  ])('keeps the shape with an EMPTY email when it is %s', (_label, email) => {
    expect(loginThrottleTracker({ ip: '1.2.3.4', body: { email } })).toBe('1.2.3.4|');
  });

  it('survives a missing or non-object body and a missing ip', () => {
    expect(loginThrottleTracker({ ip: '1.2.3.4' })).toBe('1.2.3.4|');
    expect(loginThrottleTracker({ ip: '1.2.3.4', body: 'text' })).toBe('1.2.3.4|');
    expect(loginThrottleTracker({ body: { email: 'a@b.c' } })).toBe('unknown|a@b.c');
  });

  it('caps very long emails so keys stay small', () => {
    const key = loginThrottleTracker({ ip: '1.2.3.4', body: { email: 'a'.repeat(5000) } });
    expect(key.length).toBeLessThan(300);
  });

  it('the first "|" is always the separator, even when the email contains one', () => {
    const key = loginThrottleTracker({ ip: '2001:db8::1', body: { email: 'we|ird@example.com' } });
    expect(key.slice(0, key.indexOf('|'))).toBe('2001:db8::/64');
  });
});
