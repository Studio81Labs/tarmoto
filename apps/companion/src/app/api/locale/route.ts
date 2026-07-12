import { NextResponse } from "next/server";
import { isSupportedLocale, LOCALE_COOKIE, type SupportedLocale } from "@/i18n";
import { auth } from "@/lib/auth";
import { apiServer } from "@/lib/api/server";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

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

  await syncLanguageToUserRecord(locale);

  return response;
}

export const runtime = "edge";
