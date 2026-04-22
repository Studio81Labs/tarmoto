/**
 * Shared `class-transformer` helpers for DTO query-param coercion.
 *
 * NestJS hands query params over to class-transformer as strings, and
 * the obvious `Number(value)` coercion is deceptively broken for
 * optional params: `Number('')` and `Number('  ')` both silently return
 * `0`, so `@IsOptional()` on a numeric field does nothing useful in the
 * `?foo=` / `?foo=%20` cases — a blank coordinate turns into the Gulf
 * of Guinea, a blank radius becomes "match everything within 0 km", etc.
 *
 * These helpers encode the common "blank/whitespace/nullish → unset"
 * contract so each DTO doesn't have to reinvent it (and drift from each
 * other when edge cases are added).
 */

/**
 * Coerce an optional numeric query-string value. Blank, whitespace-only,
 * and nullish inputs return `undefined` so downstream `@IsOptional()`
 * treats them as "not provided"; everything else goes through
 * `Number(value)`.
 *
 * Usage: `@Transform(toOptionalNumber)` on an optional numeric field.
 */
export const toOptionalNumber = ({ value }: { value: unknown }): unknown => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return Number(value);
};

/**
 * Coerce an optional boolean query-string value. Accepts `"true"`/`"1"`
 * (true) and `"false"`/`"0"` (false), case-insensitive; blank, whitespace,
 * and nullish inputs → `undefined`. Anything else is returned as-is so a
 * downstream `@IsBoolean()` rejects it with a clear validation error.
 *
 * The stock `@Type(() => Boolean)` is unusable here because it invokes
 * JavaScript's `Boolean(value)` constructor, which treats any non-empty
 * string (including `"false"`) as `true`.
 *
 * Usage: `@Transform(toOptionalBoolean)` on an optional boolean field.
 */
export const toOptionalBoolean = ({ value }: { value: unknown }): unknown => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === '') return undefined;
    if (trimmed === 'true' || trimmed === '1') return true;
    if (trimmed === 'false' || trimmed === '0') return false;
  }
  return value;
};
