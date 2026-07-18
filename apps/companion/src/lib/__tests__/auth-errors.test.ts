import { describe, expect, it } from "vitest";
import { makeTranslator } from "@tarmoto/shared";
import { t } from "@/i18n";
import {
  SOCIAL_ACCOUNT_CONFLICT_ERROR,
  SOCIAL_ACCOUNT_CONFLICT_MESSAGE,
  SOCIAL_SIGNIN_FAILED_ERROR,
  getLoginErrorMessage,
} from "../auth-errors";

describe("getLoginErrorMessage", () => {
  it("returns the password-account message for a social account conflict", () => {
    expect(getLoginErrorMessage(SOCIAL_ACCOUNT_CONFLICT_ERROR, t)).toBe(
      "This email already has a Tarmoto password account. Sign in with your password instead.",
    );
  });

  it("returns the generic social sign-in failure message", () => {
    expect(getLoginErrorMessage(SOCIAL_SIGNIN_FAILED_ERROR, t)).toBe(
      "We couldn't complete social sign-in. Try again or use your password.",
    );
  });

  it("returns an empty string when there is no error code", () => {
    expect(getLoginErrorMessage(null, t)).toBe("");
  });

  it("returns an empty string for an unrecognized error code", () => {
    expect(getLoginErrorMessage("some_other_error", t)).toBe("");
  });
});

// SOCIAL_ACCOUNT_CONFLICT_MESSAGE also does double duty as a cross-module
// `===` sentinel (social-auth-bridge.ts throws it, auth.ts compares against
// it to route to /login?error=social_account_conflict). It must stay the
// stable raw English constant — only the getLoginErrorMessage return boundary
// translates it. Pin the raw value so a future edit can't accidentally
// localize the constant itself and silently break that routing.
it("keeps the SOCIAL_ACCOUNT_CONFLICT_MESSAGE constant as the stable raw English sentinel", () => {
  expect(SOCIAL_ACCOUNT_CONFLICT_MESSAGE).toBe(
    "This email already has a Tarmoto password account. Sign in with your password instead.",
  );
});

// Builds a translator over a minimal en-only catalog stub (independent of the
// real companion catalog) whose values are DISTINCT sentinels ("XX-…") rather
// than an identity map. An identity map can't tell a real `t()` call apart
// from a regression that bypasses `t()` and returns the raw canonical
// English string directly — both would produce the same string. With
// sentinel values, a bypass regression returns the untranslated English text
// and these assertions fail.
describe("getLoginErrorMessage translator wiring", () => {
  const sentinelT = makeTranslator<string>({
    en: {
      [SOCIAL_ACCOUNT_CONFLICT_MESSAGE]: "XX-conflict",
      "We couldn't complete social sign-in. Try again or use your password.":
        "XX-social-fail",
    },
  });

  it("routes the social account conflict message through the translator", () => {
    expect(getLoginErrorMessage(SOCIAL_ACCOUNT_CONFLICT_ERROR, sentinelT)).toBe(
      "XX-conflict",
    );
  });

  it("routes the social sign-in failure message through the translator", () => {
    expect(getLoginErrorMessage(SOCIAL_SIGNIN_FAILED_ERROR, sentinelT)).toBe(
      "XX-social-fail",
    );
  });

  it("never calls the translator for the no-error / unrecognized-code paths", () => {
    expect(getLoginErrorMessage(null, sentinelT)).toBe("");
    expect(getLoginErrorMessage("some_other_error", sentinelT)).toBe("");
  });
});
