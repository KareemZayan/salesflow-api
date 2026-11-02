import { HOSTNAME_PATTERN, PHONE_PATTERN } from './contact-details-policy';

describe('HOSTNAME_PATTERN', () => {
  it.each(['acme.com', 'sales.acme.co.uk', 'a-b.example.io', 'xn--bcher-kva.example'])(
    'accepts %s',
    (value) => expect(HOSTNAME_PATTERN.test(value)).toBe(true),
  );

  it.each([
    'https://acme.com',
    'acme.com/about',
    'acme.com:8080',
    'www.acme.com?x=1',
    'acme',
    '-acme.com',
    'acme-.com',
    'acme .com',
    'acme..com',
    '',
    `${'a'.repeat(64)}.com`,
  ])('rejects %s', (value) => expect(HOSTNAME_PATTERN.test(value)).toBe(false));
});

describe('PHONE_PATTERN', () => {
  it.each(['+20 100 123 4567', '(02) 2345-6789', '01001234567', '+1.555.123.4567'])(
    'accepts %s',
    (value) => expect(PHONE_PATTERN.test(value)).toBe(true),
  );

  it.each(['abc', '12', '+', '12-', 'call me', '1234;DROP', '++123456'])('rejects %s', (value) =>
    expect(PHONE_PATTERN.test(value)).toBe(false),
  );
});
