import { registerDecorator, type ValidationOptions } from 'class-validator';
import { isValidFormatLocale } from '@tarmoto/shared';

/**
 * Validates a BCP-47 locale tag via `Intl.getCanonicalLocales` (shared with
 * the companion capture route, so both sides accept identical values).
 * Pair with the canonicalizing `@Transform` at the field — this validator
 * sees the already-canonicalized value on the happy path and the raw
 * original when canonicalization failed.
 */
export function IsFormatLocale(options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isFormatLocale',
      target: object.constructor,
      propertyName,
      options: {
        message: `${propertyName} must be a valid BCP-47 locale tag (e.g. cs-CZ)`,
        ...options,
      },
      validator: {
        validate: (value: unknown) => isValidFormatLocale(value),
      },
    });
  };
}
