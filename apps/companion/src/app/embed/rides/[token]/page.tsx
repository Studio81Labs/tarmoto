import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SharedRideEmbedWidget } from "../_components/SharedRideEmbedWidget";
import { type RideWidgetVariant } from "@/lib/ride-embed";
import { fetchSharedRide } from "@/lib/shared-rides";
import { siteUrl } from "@/lib/site";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: "Embed shared ride — Tarmoto",
    description: "Embeddable Tarmoto shared ride widget.",
    robots: { index: false, follow: false },
  };
}

export default async function SharedRideEmbedPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ variant?: string }>;
}) {
  const { token } = await params;
  const { variant } = await searchParams;
  const ride = await fetchSharedRide(token);
  if (!ride) notFound();

  return (
    <SharedRideEmbedWidget
      token={token}
      ride={ride}
      pageUrl={`${siteUrl()}/rides/shared/${token}`}
      variant={normalizeVariant(variant)}
    />
  );
}

function normalizeVariant(value: string | undefined): RideWidgetVariant {
  return value === "landscape" ? "landscape" : "compact";
}
