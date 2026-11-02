import { registerDecorator, ValidationOptions } from 'class-validator';
import { isCurrencyCode } from '../policies/currency-policy';

// @IsCurrencyCode(): an uppercase ISO 4217 code such as USD, EGP or EUR. Pair it with a
// @Transform that uppercases input if lowercase should be accepted.
export function IsCurrencyCode(options?: ValidationOptions): PropertyDecorator {
  return (target, propertyKey) =>
    registerDecorator({
      name: 'isCurrencyCode',
      target: target.constructor,
      propertyName: propertyKey as string,
      options: {
        message: '$property must be a valid ISO 4217 currency code, e.g. USD',
        ...options,
      },
      validator: { validate: (value: unknown) => isCurrencyCode(value) },
    });
}
