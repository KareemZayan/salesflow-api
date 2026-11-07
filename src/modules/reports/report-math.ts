import { Prisma } from '../../generated/prisma/client';
import { RATE_DECIMALS } from './reports.constants';

// A sum of Decimal(14,2) amounts as the API writes money: a string with exactly two decimals. An
// aggregate over no rows is NULL in SQL, which means 0.00 here.
export const money = (sum: Prisma.Decimal | null | undefined): string =>
  (sum ?? new Prisma.Decimal(0)).toFixed(2);

// A fraction in [0, 1], or null when there is nothing to divide by (no data is not "0%").
export function ratio(part: number, whole: number): number | null {
  if (whole === 0) return null;
  const scale = 10 ** RATE_DECIMALS;
  return Math.round((part / whole) * scale) / scale;
}
