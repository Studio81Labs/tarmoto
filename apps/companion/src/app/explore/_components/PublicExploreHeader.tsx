import { t } from "@/i18n/server";
import Link from "next/link";
import { Button } from "@tarmoto/ui";
import { AppLogo } from "@/components/AppLogo";
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
      <AppLogo label={t("Tarmoto")} />
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          renderLink={({ className, children }) => (
            <Link href={`/login?callbackUrl=${encoded}`} className={className}>
              {children}
            </Link>
          )}
        >
          {t("Sign in")}
        </Button>
        <Button
          variant="accent"
          size="sm"
          uppercase
          renderLink={({ className, children }) => (
            <Link
              href={`/register?callbackUrl=${encoded}`}
              className={className}
            >
              {children}
            </Link>
          )}
        >
          {t("Create account")}
        </Button>
      </div>
    </header>
  );
}
