import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { AppShell } from "@/components/AppShell";
import { siteUrl } from "@/lib/site";
import { readLocale, t } from "@/i18n/server";
import { PublicExploreHeader } from "../../explore/_components/PublicExploreHeader";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await readLocale();
  const title = t("Best Motorcycle Roads — Tarmoto", undefined, locale);
  const description = t(
    "Curated lists of the highest-rated motorcycle roads in each region, ranked by quality and curviness from crowdsourced rider data.",
    undefined,
    locale,
  );
  return {
    metadataBase: new URL(siteUrl()),
    title,
    description,
    alternates: { canonical: "/roads/best" },
    openGraph: {
      title,
      description,
      type: "website",
      siteName: t("Tarmoto", undefined, locale),
      url: "/roads/best",
    },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function BestRoadsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (session?.user) {
    return <AppShell>{children}</AppShell>;
  }
  return (
    <div className="flex flex-col min-h-screen bg-cream text-ink">
      <PublicExploreHeader callbackUrl="/roads/best" />
      <div className="flex-1">{children}</div>
    </div>
  );
}
