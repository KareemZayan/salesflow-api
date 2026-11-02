import {
  normalizeEmail,
  trimLowerToNull,
  trimString,
  trimToNull,
  trimToUndefined,
} from './string-transform.util';

const run = (fn: (p: { value: unknown }) => unknown, value: unknown) => fn({ value });

describe('string transforms', () => {
  it('trimString trims strings and passes other types through', () => {
    expect(run(trimString, '  a ')).toBe('a');
    expect(run(trimString, 5)).toBe(5);
    expect(run(trimString, null)).toBeNull();
  });

  it('normalizeEmail trims and lowercases', () => {
    expect(run(normalizeEmail, ' A@B.Com ')).toBe('a@b.com');
  });

  it('trimToNull turns blank into null but keeps undefined and null', () => {
    expect(run(trimToNull, '   ')).toBeNull();
    expect(run(trimToNull, ' x ')).toBe('x');
    expect(run(trimToNull, undefined)).toBeUndefined();
    expect(run(trimToNull, null)).toBeNull();
  });

  it('trimLowerToNull trims, lowercases and turns blank into null', () => {
    expect(run(trimLowerToNull, ' A@B.Com ')).toBe('a@b.com');
    expect(run(trimLowerToNull, '  ')).toBeNull();
    expect(run(trimLowerToNull, undefined)).toBeUndefined();
    expect(run(trimLowerToNull, null)).toBeNull();
    expect(run(trimLowerToNull, 5)).toBe(5);
  });

  it('trimToUndefined turns blank into undefined', () => {
    expect(run(trimToUndefined, '  ')).toBeUndefined();
    expect(run(trimToUndefined, ' q ')).toBe('q');
  });
});
