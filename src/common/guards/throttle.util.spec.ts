import { authThrottleTracker } from './throttle.util';

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
