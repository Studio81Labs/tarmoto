import type { components } from "@tarmoto/openapi-client";
import type { SupportedLocale } from "@tarmoto/shared";
import { apiServer } from "@/lib/api/server";
import { SOCIAL_ACCOUNT_CONFLICT_MESSAGE } from "@/lib/auth-errors";

/** Backend auth response for login / register / refresh. */
export type BackendAuthResponse = components["schemas"]["AuthResponseDto"];

interface BridgeUser {
  email: string | null | undefined;
  displayName: string | null | undefined;
}

interface ExchangeOptions {
  /**
   * Overrides the HMAC secret — defaults to `AUTH_SECRET`. Tests pass a fixed
   * value so the derived bridge password is deterministic.
   */
  bridgeSecret?: string;
  /** Locale resolved from the OAuth callback request for new accounts. */
  locale?: SupportedLocale;
}

function normalizeEmail(email: string): string {
  // Auth email normalization must be stable regardless of the UI locale.
  // eslint-disable-next-line tarmoto-localization/no-locale-insensitive-search
  return email.trim().toLowerCase();
}

function fallbackDisplayName(email: string): string {
  return normalizeEmail(email).split("@")[0] ?? "Tarmoto rider";
}

/** Pull a `{ message }` out of an openapi-fetch error body, when present. */
function errorMessage(error: unknown): string | null {
  return error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : null;
}

// Uses Web Crypto (subtle) instead of node:crypto so the auth module can
// also load inside the Edge-runtime middleware without dragging in a
// node-only dependency. Both Node 18+ and the workerd Edge runtime expose
// the same SubtleCrypto API.
export async function buildSocialBridgePassword(
  email: string,
  bridgeSecret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(bridgeSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(normalizeEmail(email)),
  );
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Exchange a verified OAuth user for the backend's existing auth tokens
 * without changing the NestJS contract. This only runs server-side from
 * Auth.js callbacks, so the derived password never reaches the browser.
 *
 * Registers the derived credentials; on a 409 (email already registered) it
 * falls back to logging in with the same derived password. A 401 on that login
 * means the email belongs to a real password account, surfaced as a conflict.
 */
export async function exchangeOAuthUserForBackendTokens(
  user: BridgeUser,
  options: ExchangeOptions = {},
): Promise<BackendAuthResponse> {
  const email =
    typeof user.email === "string" ? normalizeEmail(user.email) : "";
  if (!email) {
    throw new Error("Social sign-in requires an email address.");
  }

  const bridgeSecret =
    options.bridgeSecret?.trim() ?? process.env.AUTH_SECRET?.trim();
  if (!bridgeSecret) {
    throw new Error("AUTH_SECRET must be configured for social sign-in.");
  }

  const password = await buildSocialBridgePassword(email, bridgeSecret);
  const displayName = user.displayName?.trim() || fallbackDisplayName(email);

  const register = await apiServer.POST("/api/v1/auth/register", {
    body: { email, password, display_name: displayName },
    ...(options.locale
      ? { headers: { "Accept-Language": options.locale } }
      : {}),
  });
  if (register.response.ok && register.data) {
    return register.data;
  }
  if (register.response.status !== 409) {
    throw new Error(
      errorMessage(register.error) ?? "Could not finish social sign-in.",
    );
  }

  const login = await apiServer.POST("/api/v1/auth/login", {
    body: { email, password },
  });
  if (login.response.ok && login.data) {
    return login.data;
  }
  if (login.response.status === 401) {
    throw new Error(SOCIAL_ACCOUNT_CONFLICT_MESSAGE);
  }
  throw new Error(
    errorMessage(login.error) ?? "Could not sign in with this social account.",
  );
}
