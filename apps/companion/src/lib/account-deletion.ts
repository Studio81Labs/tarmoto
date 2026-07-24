// Account deletion is a one-way, high-blast-radius action. We require the user
// to type their own email address verbatim before enabling the final button —
// same pattern GitHub uses for repo deletion — so muscle memory ("I'll just
// click OK") can't wipe an account.

export function isDeletionConfirmed(
  typed: string,
  email: string | null | undefined,
): boolean {
  if (!email) return false;
  // Email identity comparison follows the existing locale-neutral auth rule.
  // eslint-disable-next-line tarmoto-localization/no-locale-insensitive-search
  return typed.trim().toLowerCase() === email.trim().toLowerCase();
}
