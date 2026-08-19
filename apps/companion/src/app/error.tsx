"use client";

import * as Sentry from "@sentry/nextjs";
import { useTranslation } from "@/i18n/I18nProvider";

import { useEffect } from "react";
import Link from "next/link";
import { Button, ErrorState } from "@tarmoto/ui";
/**
 * Route error boundary — any render/data crash below the root layout lands
 * here as the v2 "System state · 500" screen. `reset()` re-renders the
 * failed segment; "Back to home" is the escape hatch when retrying loops.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslation();
  useEffect(() => {
    // Server components log their own errors; this covers client-side
    // crashes so the digest is greppable in the browser console too.
    console.error(error);
    // A boundary-caught error is "handled" as far as the SDK's global
    // handlers are concerned, so without this explicit capture every crash
    // that lands here is invisible to Sentry — the map-page crash of #1255
    // went unreported for exactly this reason. No-op when Sentry is
    // disabled (no DSN baked in).
    Sentry.captureException(error);
  }, [error]);

  return (
    <main>
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
            <Button variant="accent" uppercase onClick={reset}>
              {t("Reload page")}
            </Button>
            <Link
              href="/"
              className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-ink/[0.18] bg-transparent px-4 py-[11px] text-[12.5px] font-bold uppercase tracking-[0.4px] text-ink transition hover:bg-paper"
            >
              {t("Back to home")}
            </Link>
          </>
        }
      />
    </main>
  );
}
