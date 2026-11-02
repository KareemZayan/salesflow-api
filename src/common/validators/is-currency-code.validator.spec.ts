import { validate } from 'class-validator';
import { isCurrencyCode } from '../policies/currency-policy';
import { IsCurrencyCode } from './is-currency-code.validator';

class Probe {
  @IsCurrencyCode()
  currency!: unknown;
}

const errorsFor = async (currency: unknown) => {
  const probe = new Probe();
  probe.currency = currency;
  return validate(probe);
};

describe('currency code', () => {
  it.each(['USD', 'EGP', 'EUR'])('accepts %s', async (code) => {
    expect(isCurrencyCode(code)).toBe(true);
    expect(await errorsFor(code)).toHaveLength(0);
  });

  it.each(['XXX1', 'usd1', 'usd', 'US', 'USDD', '', 'ZZZ', 123, null, undefined])(
    'rejects %j',
    async (code) => {
      expect(isCurrencyCode(code)).toBe(false);
      expect(await errorsFor(code)).toHaveLength(1);
    },
  );
});
