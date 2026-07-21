"use client";

import { useEffect } from "react";
import { ErrorState } from "@tarmoto/ui";
import { getActiveLocale, t } from "@/i18n";
import "./globals.css";

/**
 * Root-level error boundary: catches crashes in the root layout itself
 * (providers, fonts, i18n bootstrap) that `app/error.tsx` — nested BELOW
 * the layout — can never see. It replaces the whole document, so it ships
 * its own <html>/<body> shell, imports the global styles directly, and
 * deliberately avoids every app provider. The synchronous translator is
 * provider-independent and defaults safely to English if locale bootstrap was
 * the failing code; navigation remains a plain anchor for the same reason.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang={getActiveLocale()}>
      <body className="bg-cream font-sans text-ink antialiased">
        <ErrorState
          className="min-h-screen"
          kind="server"
          code="500"
          label={t("Server error")}
          title={t("Something skidded out")}
          body={t(
            "A problem on our end interrupted the request. We’ve logged it — give it another go in a moment.",
          )}
          actions={
            <>
              <button
                type="button"
                onClick={reset}
                className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-accent bg-accent px-4 py-[11px] text-[12.5px] font-bold uppercase tracking-[0.4px] text-ink transition hover:brightness-95"
              >
                {t("Reload page")}
              </button>
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages --
                  the root layout (and with it the client router) just
                  crashed; a hard <a> navigation is the reliable escape. */}
              <a
                href="/"
                className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-ink/[0.18] bg-transparent px-4 py-[11px] text-[12.5px] font-bold uppercase tracking-[0.4px] text-ink transition hover:bg-paper"
              >
                {t("Back to home")}
              </a>
            </>
          }
        />
      </body>
    </html>
  );
}
