/**
 * Normalize a mutation/query error into a user-facing string. Server errors
 * arrive as `{ message: string | string[] }` — a `string[]` (class-validator
 * field errors) is joined, a plain string is used as-is, and anything
 * unrecognized falls back to the supplied default.
 */
export function serverMessage(err: unknown, fallback: string): string {
  const m = (err as { message?: string | string[] } | undefined)?.message;
  if (Array.isArray(m)) return m.join("; ");
  return m ?? fallback;
}
