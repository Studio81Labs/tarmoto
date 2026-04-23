import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { findCountry, findRegion, listIndexableRegions } from "@tarmoto/shared";
import { fetchBestRoads } from "@/lib/bestRoads";
import { siteUrl } from "@/lib/site";
import type { BestRoadsWidgetVariant } from "@/lib/best-roads-embed";
import { BestRoadsEmbedWidget } from "../../_components/BestRoadsEmbedWidget";

export const revalidate = 604800;

export function generateStaticParams() {
  return listIndexableRegions()
    .filter((region) => !region.parent)
    .map((region) => ({ country: region.country, region: region.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ country: string; region: string }>;
}): Promise<Metadata> {
  const { country, region } = await params;
  const regionMeta = findRegion(country, region);
  if (!regionMeta || regionMeta.parent) return {};
  return {
    title: `Embed best roads in ${regionMeta.name} — Tarmoto`,
    description: `Embeddable road-quality widget for ${regionMeta.name}.`,
    robots: { index: false, follow: false },
  };
}

export default async function BestRoadsEmbedRegionPage({
  params,
  searchParams,
}: {
  params: Promise<{ country: string; region: string }>;
  searchParams: Promise<{ variant?: string }>;
}) {
  const { country, region } = await params;
  const { variant } = await searchParams;
  const countryMeta = findCountry(country);
  const regionMeta = findRegion(country, region);
  if (!countryMeta || !regionMeta || regionMeta.parent) notFound();

  const payload = await fetchBestRoads(country, region, 6);
  if (!payload) notFound();

  return (
    <BestRoadsEmbedWidget
      country={countryMeta}
      region={regionMeta}
      roads={payload.roads}
      pageUrl={`${siteUrl()}/roads/best/${country}/${region}`}
      variant={normalizeVariant(variant)}
    />
  );
}

function normalizeVariant(value: string | undefined): BestRoadsWidgetVariant {
  return value === "landscape" ? "landscape" : "compact";
}
