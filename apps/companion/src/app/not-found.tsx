import Link from "next/link";
import { ErrorState } from "@tarmoto/ui";
import { t } from "@/i18n";

// Shared by unknown routes and every `notFound()` call (missing rides,
// dead share tokens, …) — the v2 "System state · 404" screen.
export default function NotFound() {
  return (
    <main>
      <ErrorState
        className="min-h-screen"
        kind="not-found"
        code="404"
        label={t("Not found")}
        title={t("This road isn’t on the map")}
        body={t(
          "The route or page you’re after has moved, ended, or never existed. Let’s get you back on tarmac.",
        )}
        actions={
          <>
            <Link
              href="/"
              className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-accent bg-accent px-4 py-[11px] text-[12.5px] font-bold uppercase tracking-[0.4px] text-ink transition hover:brightness-95"
            >
              {t("Back to home")}
            </Link>
            <Link
              href="/explore"
              className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-ink/[0.18] bg-transparent px-4 py-[11px] text-[12.5px] font-bold uppercase tracking-[0.4px] text-ink transition hover:bg-paper"
            >
              {t("Open Road Explorer")}
            </Link>
          </>
        }
      />
    </main>
  );
}
