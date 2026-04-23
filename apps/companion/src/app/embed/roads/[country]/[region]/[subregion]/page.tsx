import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { findCountry, findRegion, listIndexableRegions } from "@tarmoto/shared";
import { fetchBestRoads } from "@/lib/bestRoads";
import { siteUrl } from "@/lib/site";
import type { BestRoadsWidgetVariant } from "@/lib/best-roads-embed";
import { BestRoadsEmbedWidget } from "../../../_components/BestRoadsEmbedWidget";

export const revalidate = 604800;

export function generateStaticParams() {
  return listIndexableRegions()
    .filter((region) => !!region.parent)
    .map((region) => ({
      country: region.country,
      region: region.parent!,
      subregion: region.slug,
    }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ country: string; region: string; subregion: string }>;
}): Promise<Metadata> {
  const { country, region, subregion } = await params;
  const regionMeta = findRegion(country, subregion);
  if (!regionMeta || regionMeta.parent !== region) return {};
  return {
    title: `Embed best roads in ${regionMeta.name} — Tarmoto`,
    description: `Embeddable road-quality widget for ${regionMeta.name}.`,
    robots: { index: false, follow: false },
  };
}

export default async function BestRoadsEmbedSubregionPage({
  params,
  searchParams,
}: {
  params: Promise<{ country: string; region: string; subregion: string }>;
  searchParams: Promise<{ variant?: string }>;
}) {
  const { country, region, subregion } = await params;
  const { variant } = await searchParams;
  const countryMeta = findCountry(country);
  const subregionMeta = findRegion(country, subregion);
  const parentMeta = findRegion(country, region);
  if (!countryMeta || !subregionMeta || !parentMeta) notFound();
  if (subregionMeta.parent !== region) notFound();

  const payload = await fetchBestRoads(country, subregion, 6);
  if (!payload) notFound();

  return (
    <BestRoadsEmbedWidget
      country={countryMeta}
      region={subregionMeta}
      parent={parentMeta}
      roads={payload.roads}
      pageUrl={`${siteUrl()}/roads/best/${country}/${region}/${subregion}`}
      variant={normalizeVariant(variant)}
    />
  );
}

function normalizeVariant(value: string | undefined): BestRoadsWidgetVariant {
  return value === "landscape" ? "landscape" : "compact";
}
