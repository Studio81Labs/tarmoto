export const SOCIAL_ACCOUNT_CONFLICT_ERROR = "social_account_conflict";
export const SOCIAL_SIGNIN_FAILED_ERROR = "social_signin_failed";

export const SOCIAL_ACCOUNT_CONFLICT_MESSAGE =
  "This email already has a Tarmoto password account. Sign in with your password instead.";

export function getLoginErrorMessage(errorCode: string | null): string {
  if (errorCode === SOCIAL_ACCOUNT_CONFLICT_ERROR) {
    return SOCIAL_ACCOUNT_CONFLICT_MESSAGE;
  }

  if (errorCode === SOCIAL_SIGNIN_FAILED_ERROR) {
    return "We couldn't complete social sign-in. Try again or use your password.";
  }

  return "";
}
