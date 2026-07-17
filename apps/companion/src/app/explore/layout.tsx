import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { AppShell } from "@/components/AppShell";
import { siteUrl } from "@/lib/site";
import { t } from "@/i18n";
import { readLocale } from "@/i18n/server";
import { PublicExploreHeader } from "./_components/PublicExploreHeader";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await readLocale();
  const title = t("Road Quality Explorer — Tarmoto", undefined, locale);
  const description = t(
    "Explore crowdsourced road surface quality and active hazards on an interactive map. Find the best riding roads before you head out.",
    undefined,
    locale,
  );
  return {
    metadataBase: new URL(siteUrl()),
    title,
    description,
    alternates: { canonical: "/explore" },
    openGraph: {
      title,
      description,
      type: "website",
      siteName: t("Tarmoto", undefined, locale),
      url: "/explore",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  };
}

/**
 * Reads the session server-side so authenticated vs public chrome is decided
 * before the first paint — no hydration flash when a signed-in user lands on
 * /explore.
 */
export default async function ExploreLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (session?.user) {
    return <AppShell>{children}</AppShell>;
  }

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-cream text-ink">
      <PublicExploreHeader />
      <div className="flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
