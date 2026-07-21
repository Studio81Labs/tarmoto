"use client";

import { useEffect } from "react";
import { ErrorState } from "@tarmoto/ui";
import "./globals.css";

// This is deliberately static English copy. The root error boundary must be
// able to render when loading the locale catalog or translator itself caused
// the root layout failure.
const FALLBACK_COPY = {
  label: "Server error",
  title: "Something skidded out",
  body: "A problem on our end interrupted the request. We’ve logged it — give it another go in a moment.",
  reload: "Reload page",
  home: "Back to home",
} as const;

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
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body className="bg-cream font-sans text-ink antialiased">
        <ErrorState
          className="min-h-screen"
          kind="server"
          code="500"
          label={FALLBACK_COPY.label}
          title={FALLBACK_COPY.title}
          body={FALLBACK_COPY.body}
          actions={
            <>
              <button
                type="button"
                onClick={reset}
                className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-accent bg-accent px-4 py-[11px] text-[12.5px] font-bold uppercase tracking-[0.4px] text-ink transition hover:brightness-95"
              >
                {FALLBACK_COPY.reload}
              </button>
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages --
                  the root layout (and with it the client router) just
                  crashed; a hard <a> navigation is the reliable escape. */}
              <a
                href="/"
                className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-ink/[0.18] bg-transparent px-4 py-[11px] text-[12.5px] font-bold uppercase tracking-[0.4px] text-ink transition hover:bg-paper"
              >
                {FALLBACK_COPY.home}
              </a>
            </>
          }
        />
      </body>
    </html>
  );
}
