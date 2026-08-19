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
  preferences: { format_locale?: string; timezone?: string },
  signal: AbortSignal,
): Promise<void> {
  try {
    const session = await auth();
    if (!session?.user || signal.aborted) return;

    const { error, response } = await apiServer.PATCH("/api/v1/users/me", {
      body: { preferences },
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
  const preferences: { format_locale?: string; timezone?: string } = {};
  if (raw.format_locale !== undefined) {
    const formatLocale = canonicalizeFormatLocale(raw.format_locale);
    if (!formatLocale) {
      return NextResponse.json(
        { error: "Invalid format_locale" },
        { status: 400 },
      );
    }
    preferences.format_locale = formatLocale;
  }
  if (raw.timezone !== undefined) {
    if (!isValidTimeZone(raw.timezone)) {
      return NextResponse.json({ error: "Invalid timezone" }, { status: 400 });
    }
    preferences.timezone = raw.timezone;
  }
  if (Object.keys(preferences).length === 0) {
    return NextResponse.json(
      { error: "At least one format preference is required" },
      { status: 400 },
    );
  }

  const response = NextResponse.json(preferences);
  const cookieOptions = {
    path: "/",
    maxAge: FORMAT_PREFS_COOKIE_MAX_AGE_SECONDS,
    sameSite: "lax",
    httpOnly: false,
  } as const;
  if (preferences.format_locale) {
    response.cookies.set(
      FORMAT_LOCALE_COOKIE,
      preferences.format_locale,
      cookieOptions,
    );
  }
  if (preferences.timezone) {
    response.cookies.set(TIMEZONE_COOKIE, preferences.timezone, cookieOptions);
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    syncFormatPrefsToUserRecord(preferences, controller.signal),
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
