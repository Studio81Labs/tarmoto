import { NextResponse } from "next/server";
import {
  isSupportedLocale,
  LOCALE_COOKIE,
  LOCALE_SYNC_PENDING_COOKIE,
  type SupportedLocale,
} from "@/i18n";
import { auth } from "@/lib/auth";
import { apiServer } from "@/lib/api/server";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

// Bounds the best-effort user-record sync below so a slow or hanging backend
// can't delay the cookie-set response indefinitely, and doubles as the
// deadline `POST` uses to abort the sync outright (see the `AbortController`
// there) — covering both a hung `auth()` token refresh and an in-flight
// PATCH, and blocking a *new* PATCH from firing after the deadline already
// passed (see `syncLanguageToUserRecord`'s `signal` param).
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
 *
 * Returns true only when an authenticated record accepted the locale. The
 * caller uses false to retain a separate pending-sync cookie.
 *
 * `signal` comes from the `AbortController` `POST` creates: once its deadline
 * fires, the signal aborts an in-flight PATCH, and the `signal.aborted` guard
 * below blocks a PATCH that hasn't started yet from firing at all. Without
 * that guard, a request whose `auth()` call (e.g. a token refresh) stalls
 * past the deadline could still PATCH afterwards with its now-stale locale,
 * clobbering a newer locale a later, faster request already persisted.
 */
async function syncLanguageToUserRecord(
  locale: SupportedLocale,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const session = await auth();
    if (!session?.user || signal.aborted) return false;

    const { error, response } = await apiServer.PATCH("/api/v1/users/me", {
      body: { language: locale },
      headers: { Authorization: `Bearer ${session.accessToken}` },
      signal,
    });
    if (!response.ok) {
      console.error("Failed to persist language to user record", error);
      return false;
    }
    return true;
  } catch (error) {
    console.error("Failed to persist language to user record", error);
    return false;
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
  // Set before the bounded sync starts. A successful authenticated PATCH
  // clears it below; timeout, offline, and signed-out paths deliberately keep
  // it so PreferencesSync can distinguish an explicit browser choice from an
  // ordinary (possibly stale) locale cookie.
  response.cookies.set(LOCALE_SYNC_PENDING_COOKIE, locale, {
    path: "/",
    maxAge: ONE_YEAR_SECONDS,
    sameSite: "lax",
    httpOnly: false,
  });

  // Bound the whole best-effort user-record sync so NO backend latency inside
  // it (auth()'s token refresh, or the PATCH itself) can delay the cookie
  // response. `syncLanguageToUserRecord` already swallows its own errors, so
  // this promise never rejects — the race has no unhandled-rejection risk.
  //
  // The timeout owns an `AbortController` rather than just resolving: when it
  // wins the race, it also aborts `controller.signal`, which cancels an
  // in-flight PATCH and blocks a not-yet-started one (see the `signal`
  // docstring on `syncLanguageToUserRecord`) — otherwise the sync would keep
  // running in the background and could still PATCH with a since-superseded
  // locale after this response has already gone out.
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const synced = await Promise.race([
    syncLanguageToUserRecord(locale, controller.signal),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        controller.abort(); // cancel in-flight PATCH AND block a post-deadline stale PATCH
        resolve(false); // stop gating the cookie response on backend latency
      }, LOCALE_SYNC_TIMEOUT_MS);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (synced) {
    response.cookies.delete(LOCALE_SYNC_PENDING_COOKIE);
  }

  return response;
}
