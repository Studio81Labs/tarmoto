import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { AppShell } from "@/components/AppShell";
import { siteUrl } from "@/lib/site";
import { PublicExploreHeader } from "../../explore/_components/PublicExploreHeader";

const title = "Best Motorcycle Roads — Tarmoto";
const description =
  "Curated lists of the highest-rated motorcycle roads in each region, " +
  "ranked by quality and curviness from crowdsourced rider data.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title,
  description,
  alternates: { canonical: "/roads/best" },
  openGraph: {
    title,
    description,
    type: "website",
    siteName: "Tarmoto",
    url: "/roads/best",
  },
  twitter: { card: "summary_large_image", title, description },
};

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
    <div className="flex flex-col min-h-screen bg-slate-950">
      <PublicExploreHeader callbackUrl="/roads/best" />
      <div className="flex-1">{children}</div>
    </div>
  );
}
