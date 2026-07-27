import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { AppShell } from "@/components/AppShell";
import { siteUrl } from "@/lib/site";
import { readLocale, t } from "@/i18n/server";
import { publicLanguageAlternates, publicLocalePath } from "@/i18n";
import { PublicExploreHeader } from "../../explore/_components/PublicExploreHeader";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await readLocale();
  const title = t("Best Motorcycle Roads — Tarmoto", undefined, locale);
  const description = t(
    "Curated lists of the highest-rated motorcycle roads in each region, ranked by quality and curviness from crowdsourced rider data.",
    undefined,
    locale,
  );
  const canonicalPath = publicLocalePath("/roads/best", locale);
  return {
    metadataBase: new URL(siteUrl()),
    title,
    description,
    alternates: {
      canonical: canonicalPath,
      languages: publicLanguageAlternates("/roads/best"),
    },
    openGraph: {
      title,
      description,
      type: "website",
      siteName: t("Tarmoto", undefined, locale),
      url: canonicalPath,
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
  const locale = await readLocale();
  return (
    <div className="flex flex-col min-h-screen bg-cream text-ink">
      <PublicExploreHeader
        callbackUrl={publicLocalePath("/roads/best", locale)}
      />
      <div className="flex-1">{children}</div>
    </div>
  );
}
