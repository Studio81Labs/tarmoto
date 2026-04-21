import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { findCountry, findRegion, listIndexableRegions } from "@tarmoto/shared";
import { fetchBestRoads } from "@/lib/bestRoads";
import { siteUrl } from "@/lib/site";
import { BestRoadsPageBody } from "../_components/BestRoadsPageBody";

export const revalidate = 604800;

export function generateStaticParams() {
  return listIndexableRegions()
    .filter((r) => !!r.parent)
    .map((r) => ({
      country: r.country,
      region: r.parent!,
      subregion: r.slug,
    }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ country: string; region: string; subregion: string }>;
}): Promise<Metadata> {
  const { country, region, subregion } = await params;
  const r = findRegion(country, subregion);
  if (!r || r.parent !== region) return {};
  return {
    title: `Best motorcycle roads in ${r.name} — Tarmoto`,
    description: r.description,
    alternates: {
      canonical: `/roads/best/${r.country}/${r.parent}/${r.slug}`,
    },
  };
}

export default async function BestRoadsSubRegionPage({
  params,
}: {
  params: Promise<{ country: string; region: string; subregion: string }>;
}) {
  const { country, region: parentSlug, subregion } = await params;
  const regionMeta = findRegion(country, subregion);
  const parentMeta = findRegion(country, parentSlug);
  const countryMeta = findCountry(country);
  if (
    !regionMeta ||
    !parentMeta ||
    !countryMeta ||
    regionMeta.parent !== parentSlug
  ) {
    notFound();
  }

  const payload = await fetchBestRoads(country, subregion, 10);
  if (!payload) notFound();

  const pageUrl = `${siteUrl()}/roads/best/${country}/${parentSlug}/${subregion}`;

  return (
    <BestRoadsPageBody
      region={regionMeta}
      country={countryMeta}
      parent={parentMeta}
      pageUrl={pageUrl}
      roads={payload.roads}
    />
  );
}
