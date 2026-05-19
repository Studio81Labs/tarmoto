import { t } from "@/i18n";
import Link from "next/link";
interface Props {
  /** Path the user returns to after completing auth. Defaults to /explore. */
  callbackUrl?: string;
}
/**
 * Compact header rendered above the map for unauthenticated visitors. Keeps
 * the sign-in / create-account CTAs discoverable without taking space away
 * from the heatmap itself.
 */
export function PublicExploreHeader({ callbackUrl = "/explore" }: Props = {}) {
  const encoded = encodeURIComponent(callbackUrl);
  return (
    <header className="flex h-14 items-center justify-between border-b border-line px-4 md:px-6">
      <Link href="/" className="text-lg font-extrabold tracking-tight text-ink">
        <span className="text-accent">{t("T")}</span>
        {t("armoto ")}
      </Link>
      <div className="flex items-center gap-2">
        <Link
          href={`/login?callbackUrl=${encoded}`}
          className="px-3 py-1.5 rounded-md text-sm font-semibold text-fg-dim hover:text-ink hover:bg-paper transition"
        >
          {t("Sign in ")}
        </Link>
        <Link
          href={`/register?callbackUrl=${encoded}`}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-ink font-bold text-[11px] uppercase tracking-[0.2px] hover:brightness-95 transition"
        >
          {t("Create account ")}
        </Link>
      </div>
    </header>
  );
}
