import { createHmac } from "crypto";
import { API_BASE_SERVER } from "@/lib/config";
import { SOCIAL_ACCOUNT_CONFLICT_MESSAGE } from "@/lib/auth-errors";

export interface BackendAuthResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: {
    id: string;
    email: string;
    display_name: string;
    phone?: string;
    created_at: string;
  };
}

interface BridgeUser {
  email: string | null | undefined;
  displayName: string | null | undefined;
}

interface ExchangeOptions {
  apiBaseServer?: string;
  bridgeSecret?: string;
  fetchImpl?: typeof fetch;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function fallbackDisplayName(email: string): string {
  return normalizeEmail(email).split("@")[0] ?? "Tarmoto rider";
}

async function readErrorMessage(response: Response): Promise<string | null> {
  const body = await response.json().catch(() => null);
  const message =
    body &&
    typeof body === "object" &&
    "message" in body &&
    typeof body.message === "string"
      ? body.message
      : null;

  return message;
}

export function buildSocialBridgePassword(
  email: string,
  bridgeSecret: string,
): string {
  return createHmac("sha256", bridgeSecret)
    .update(normalizeEmail(email))
    .digest("hex");
}

/**
 * Exchange a verified OAuth user for the backend's existing auth tokens
 * without changing the NestJS contract. This only runs server-side from
 * Auth.js callbacks, so the derived password never reaches the browser.
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

  const password = buildSocialBridgePassword(email, bridgeSecret);
  const displayName = user.displayName?.trim() || fallbackDisplayName(email);
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBaseServer = options.apiBaseServer ?? API_BASE_SERVER;

  const registerResponse = await fetchImpl(`${apiBaseServer}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password,
      display_name: displayName,
    }),
  });

  if (registerResponse.ok) {
    return (await registerResponse.json()) as BackendAuthResponse;
  }

  if (registerResponse.status !== 409) {
    const message = await readErrorMessage(registerResponse);
    throw new Error(message ?? "Could not finish social sign-in.");
  }

  const loginResponse = await fetchImpl(`${apiBaseServer}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (loginResponse.ok) {
    return (await loginResponse.json()) as BackendAuthResponse;
  }

  if (loginResponse.status === 401) {
    throw new Error(SOCIAL_ACCOUNT_CONFLICT_MESSAGE);
  }

  const message = await readErrorMessage(loginResponse);
  throw new Error(message ?? "Could not sign in with this social account.");
}
