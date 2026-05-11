import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { AppShell } from "@/components/AppShell";
import { siteUrl } from "@/lib/site";
import { PublicExploreHeader } from "../explore/_components/PublicExploreHeader";

const title = "Discover the best motorcycling regions — Tarmoto";
const description =
  "Explore crowdsourced Fun Zones — clusters of the highest-rated " +
  "motorcycle roads — on an interactive map. Draw a region to filter " +
  "zones, then click into any zone to see its top roads and " +
  "elevation profiles.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title,
  description,
  alternates: { canonical: "/discover" },
  openGraph: {
    title,
    description,
    type: "website",
    siteName: "Tarmoto",
    url: "/discover",
  },
  twitter: { card: "summary_large_image", title, description },
};

export default async function DiscoverLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (session?.user) {
    return <AppShell>{children}</AppShell>;
  }
  return (
    <div className="tarmoto-no-cream flex flex-col h-screen overflow-hidden bg-slate-950">
      <PublicExploreHeader callbackUrl="/discover" />
      <div className="flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
