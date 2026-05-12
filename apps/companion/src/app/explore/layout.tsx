import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { AppShell } from "@/components/AppShell";
import { siteUrl } from "@/lib/site";
import { PublicExploreHeader } from "./_components/PublicExploreHeader";

const title = "Road Quality Explorer — Tarmoto";
const description =
  "Explore crowdsourced road surface quality and active hazards on an interactive map. Find the best riding roads before you head out.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title,
  description,
  alternates: { canonical: "/explore" },
  openGraph: {
    title,
    description,
    type: "website",
    siteName: "Tarmoto",
    url: "/explore",
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
  },
};

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
    <div className="tarmoto-no-cream flex flex-col h-screen overflow-hidden bg-slate-950">
      <PublicExploreHeader />
      <div className="flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
