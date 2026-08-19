"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect, useState } from "react";
import { ErrorState } from "@tarmoto/ui";
import {
  getEmergencyCopy,
  readEmergencyLocaleFromBrowser,
  type EmergencyLocale,
} from "./emergency-copy";
import "./globals.css";

/**
 * Root-level error boundary: catches crashes in the root layout itself
 * (providers, fonts, i18n bootstrap) that `app/error.tsx` — nested BELOW
 * the layout — can never see. It replaces the whole document, so it ships
 * its own <html>/<body> shell, imports the global styles directly, and
 * deliberately avoids every app provider and the i18n module itself;
 * navigation remains a plain anchor for the same reason.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [locale, setLocale] = useState<EmergencyLocale>("en");
  const copy = getEmergencyCopy(locale);

  useEffect(() => {
    console.error(error);
    // Root-layout crashes escape the regular App Router error boundaries, so
    // without this explicit capture they never reach Sentry. No-op when
    // Sentry is disabled (no DSN baked in).
    Sentry.captureException(error);
    setLocale(readEmergencyLocaleFromBrowser());
  }, [error]);

  return (
    <html lang={locale}>
      <body className="bg-cream font-sans text-ink antialiased">
        <ErrorState
          className="min-h-screen"
          kind="server"
          code="500"
          label={copy.label}
          title={copy.title}
          body={copy.body}
          actions={
            <>
              <button
                type="button"
                onClick={reset}
                className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-accent bg-accent px-4 py-[11px] text-[12.5px] font-bold uppercase tracking-[0.4px] text-ink transition hover:brightness-95"
              >
                {copy.reload}
              </button>
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages --
                  the root layout (and with it the client router) just
                  crashed; a hard <a> navigation is the reliable escape. */}
              <a
                href="/"
                className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-ink/[0.18] bg-transparent px-4 py-[11px] text-[12.5px] font-bold uppercase tracking-[0.4px] text-ink transition hover:bg-paper"
              >
                {copy.home}
              </a>
            </>
          }
        />
      </body>
    </html>
  );
}
