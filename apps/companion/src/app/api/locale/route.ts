import { NextResponse } from "next/server";
import { isSupportedLocale, LOCALE_COOKIE, type SupportedLocale } from "@/i18n";
import { auth } from "@/lib/auth";
import { apiServer } from "@/lib/api/server";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

// Bounds the best-effort user-record sync below so a slow or hanging backend
// can't delay the cookie-set response indefinitely. Used both as the PATCH's
// own abort timeout and as the outer race's cap in `POST` (which also covers
// a hung `auth()` token refresh, upstream of the PATCH).
const LOCALE_SYNC_TIMEOUT_MS = 3000;

/**
 * Best-effort sync of the rider's language choice to their user record, so
 * the backend (digest cron, transactional emails) picks it up too. Failures
 * are logged and swallowed — the `tarmoto-locale` cookie set by the caller is
 * already the source of truth for the companion UI, so a transient backend
 * hiccup must not turn a language toggle into a hard failure.
 *
 * Uses `apiServer` (no session middleware wired in, unlike the browser `api`
 * client) with the bearer attached explicitly per-request, since this is the
 * one server-side caller that actually has an authenticated session to hand
 * it — see the docstring on `apiServer`.
 */
async function syncLanguageToUserRecord(
  locale: SupportedLocale,
): Promise<void> {
  try {
    const session = await auth();
    if (!session?.user) return;

    const { error, response } = await apiServer.PATCH("/api/v1/users/me", {
      body: { language: locale },
      headers: { Authorization: `Bearer ${session.accessToken}` },
      signal: AbortSignal.timeout(LOCALE_SYNC_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error("Failed to persist language to user record", error);
    }
  } catch (error) {
    console.error("Failed to persist language to user record", error);
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const locale =
    body && typeof body === "object" && "locale" in body
      ? (body as { locale: unknown }).locale
      : undefined;

  if (typeof locale !== "string" || !isSupportedLocale(locale)) {
    return NextResponse.json({ error: "Unsupported locale" }, { status: 400 });
  }

  const response = NextResponse.json({ locale });
  response.cookies.set(LOCALE_COOKIE, locale, {
    path: "/",
    maxAge: ONE_YEAR_SECONDS,
    sameSite: "lax",
    httpOnly: false,
  });

  // Bound the whole best-effort user-record sync so NO backend latency inside
  // it (auth()'s token refresh, or the PATCH itself) can delay the cookie
  // response. `syncLanguageToUserRecord` already swallows its own errors, so
  // this promise never rejects — the race has no unhandled-rejection risk.
  await Promise.race([
    syncLanguageToUserRecord(locale),
    new Promise<void>((resolve) => setTimeout(resolve, LOCALE_SYNC_TIMEOUT_MS)),
  ]);

  return response;
}

export const runtime = "edge";
