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
    <header className="flex h-14 items-center justify-between border-b border-slate-800 px-4 md:px-6">
      <Link href="/" className="text-lg font-bold tracking-tight">
        <span className="text-tarmoto-cyan">{t("T")}</span>
        {t("armoto ")}
      </Link>
      <div className="flex items-center gap-2">
        <Link
          href={`/login?callbackUrl=${encoded}`}
          className="px-3 py-1.5 rounded-lg text-sm text-slate-300 hover:text-white hover:bg-slate-800 transition"
        >
          {t("Sign in ")}
        </Link>
        <Link
          href={`/register?callbackUrl=${encoded}`}
          className="px-3 py-1.5 rounded-lg text-sm font-medium bg-tarmoto-cyan/10 text-tarmoto-cyan hover:bg-tarmoto-cyan/20 transition"
        >
          {t("Create account ")}
        </Link>
      </div>
    </header>
  );
}
