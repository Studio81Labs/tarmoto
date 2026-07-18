import type { Translate } from "@/i18n";

export const SOCIAL_ACCOUNT_CONFLICT_ERROR = "social_account_conflict";
export const SOCIAL_SIGNIN_FAILED_ERROR = "social_signin_failed";

// Not just a display string — social-auth-bridge.ts throws this exact
// message and auth.ts does an `===` comparison against it to decide whether
// to redirect to /login?error=social_account_conflict or the generic
// social_signin_failed. Keep it the stable raw English sentinel; translate
// only at the getLoginErrorMessage return boundary below, never here.
export const SOCIAL_ACCOUNT_CONFLICT_MESSAGE =
  "This email already has a Tarmoto password account. Sign in with your password instead.";

export function getLoginErrorMessage(
  errorCode: string | null,
  t: Translate,
): string {
  if (errorCode === SOCIAL_ACCOUNT_CONFLICT_ERROR) {
    return t(SOCIAL_ACCOUNT_CONFLICT_MESSAGE);
  }

  if (errorCode === SOCIAL_SIGNIN_FAILED_ERROR) {
    return t(
      "We couldn't complete social sign-in. Try again or use your password.",
    );
  }

  return "";
}
