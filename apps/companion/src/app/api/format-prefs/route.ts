import { NextResponse } from "next/server";
import { canonicalizeFormatLocale, isValidTimeZone } from "@tarmoto/shared";
import {
  FORMAT_LOCALE_COOKIE,
  FORMAT_PREFS_COOKIE_MAX_AGE_SECONDS,
  TIMEZONE_COOKIE,
} from "@/format";
import { auth } from "@/lib/auth";
import { apiServer } from "@/lib/api/server";

// Same bounded best-effort shape as /api/locale — see that route's comments
// for the full rationale (timeout owns an AbortController so a stalled
// auth()/PATCH can neither delay the cookie response nor fire late with
// since-superseded values).
const FORMAT_PREFS_SYNC_TIMEOUT_MS = 3000;

async function syncFormatPrefsToUserRecord(
  formatLocale: string,
  timezone: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    const session = await auth();
    if (!session?.user || signal.aborted) return;

    const { error, response } = await apiServer.PATCH("/api/v1/users/me", {
      body: { preferences: { format_locale: formatLocale, timezone } },
      headers: { Authorization: `Bearer ${session.accessToken}` },
      signal,
    });
    if (!response.ok) {
      console.error(
        "Failed to persist format preferences to user record",
        error,
      );
    }
  } catch (error) {
    console.error("Failed to persist format preferences to user record", error);
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const raw = (body ?? {}) as { format_locale?: unknown; timezone?: unknown };
  const formatLocale = canonicalizeFormatLocale(raw.format_locale);
  if (!formatLocale) {
    return NextResponse.json(
      { error: "Invalid format_locale" },
      { status: 400 },
    );
  }
  if (!isValidTimeZone(raw.timezone)) {
    return NextResponse.json({ error: "Invalid timezone" }, { status: 400 });
  }
  const timezone = raw.timezone;

  const response = NextResponse.json({ format_locale: formatLocale, timezone });
  const cookieOptions = {
    path: "/",
    maxAge: FORMAT_PREFS_COOKIE_MAX_AGE_SECONDS,
    sameSite: "lax",
    httpOnly: false,
  } as const;
  response.cookies.set(FORMAT_LOCALE_COOKIE, formatLocale, cookieOptions);
  response.cookies.set(TIMEZONE_COOKIE, timezone, cookieOptions);

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    syncFormatPrefsToUserRecord(formatLocale, timezone, controller.signal),
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve();
      }, FORMAT_PREFS_SYNC_TIMEOUT_MS);
    }),
  ]);
  if (timer) clearTimeout(timer);

  return response;
}

export const runtime = "edge";
