"use client";

import { useEffect } from "react";
import { ErrorState } from "@tarmoto/ui";
import "./globals.css";

/**
 * Root-level error boundary: catches crashes in the root layout itself
 * (providers, fonts, i18n bootstrap) that `app/error.tsx` — nested BELOW
 * the layout — can never see. It replaces the whole document, so it ships
 * its own <html>/<body> shell, imports the global styles directly, and
 * deliberately avoids every app provider: raw strings instead of t(),
 * a plain <a> instead of next/link.
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
          /* eslint-disable-next-line no-restricted-syntax -- see file-level
             comment: this boundary may be recovering from a crashed i18n
             bootstrap, so it deliberately avoids importing `t()`. */
          label="Server error"
          /* eslint-disable-next-line no-restricted-syntax -- see file-level
             comment: this boundary may be recovering from a crashed i18n
             bootstrap, so it deliberately avoids importing `t()`. */
          title="Something skidded out"
          body="A problem on our end interrupted the request. We’ve logged it — give it another go in a moment."
          actions={
            <>
              <button
                type="button"
                onClick={reset}
                className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-accent bg-accent px-4 py-[11px] text-[12.5px] font-bold uppercase tracking-[0.4px] text-ink transition hover:brightness-95"
              >
                Reload page
              </button>
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages --
                  the root layout (and with it the client router) just
                  crashed; a hard <a> navigation is the reliable escape. */}
              <a
                href="/"
                className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-ink/[0.18] bg-transparent px-4 py-[11px] text-[12.5px] font-bold uppercase tracking-[0.4px] text-ink transition hover:bg-paper"
              >
                Back to home
              </a>
            </>
          }
        />
      </body>
    </html>
  );
}
