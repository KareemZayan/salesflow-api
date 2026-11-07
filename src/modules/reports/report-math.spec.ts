import { Prisma } from '../../generated/prisma/client';
import { money, ratio } from './report-math';

describe('money', () => {
  it('writes two decimals, including zero', () => {
    expect(money(new Prisma.Decimal('1250'))).toBe('1250.00');
    expect(money(new Prisma.Decimal('0.5'))).toBe('0.50');
    expect(money(new Prisma.Decimal('0'))).toBe('0.00');
  });

  it('an aggregate over no rows (SQL NULL) is 0.00', () => {
    expect(money(null)).toBe('0.00');
    expect(money(undefined)).toBe('0.00');
  });

  it('is exact where a float is not', () => {
    expect(money(new Prisma.Decimal('0.1').plus('0.2'))).toBe('0.30');
    expect(money(new Prisma.Decimal('999999999999.99'))).toBe('999999999999.99');
  });
});

describe('ratio', () => {
  it('is null (not 0) without a denominator', () => {
    expect(ratio(0, 0)).toBeNull();
    expect(ratio(5, 0)).toBeNull();
  });

  it('is a fraction rounded to 4 decimals', () => {
    expect(ratio(1, 3)).toBe(0.3333);
    expect(ratio(2, 3)).toBe(0.6667);
    expect(ratio(0, 7)).toBe(0);
    expect(ratio(7, 7)).toBe(1);
  });
});
