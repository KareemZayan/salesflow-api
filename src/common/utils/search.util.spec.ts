import { containsAny, escapeLike } from './search.util';

describe('escapeLike', () => {
  it('escapes %, _ and the backslash itself', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeLike('Acme Ltd')).toBe('Acme Ltd');
  });
});

describe('containsAny', () => {
  it('builds a case-insensitive OR over every field', () => {
    expect(containsAny('acme', ['name', 'domain'])).toEqual({
      OR: [
        { name: { contains: 'acme', mode: 'insensitive' } },
        { domain: { contains: 'acme', mode: 'insensitive' } },
      ],
    });
  });

  it('trims the term and escapes wildcards', () => {
    expect(containsAny('  a_b ', ['name'])).toEqual({
      OR: [{ name: { contains: 'a\\_b', mode: 'insensitive' } }],
    });
  });

  it.each([undefined, '', '   '])('adds no filter for %j', (q) => {
    expect(containsAny(q, ['name'])).toBeUndefined();
  });
});
