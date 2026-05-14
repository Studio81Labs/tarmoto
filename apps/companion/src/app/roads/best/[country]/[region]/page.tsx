import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { findCountry, findRegion, listIndexableRegions } from "@tarmoto/shared";
import { fetchBestRoads } from "@/lib/bestRoads";
import { siteUrl } from "@/lib/site";
import {
  buildBestRoadsMetadata,
  normalizeCountryParam,
  normalizeSlugParam,
} from "@/lib/best-roads-metadata";
import { BestRoadsPageBody } from "./_components/BestRoadsPageBody";

export const revalidate = 604800;

export function generateStaticParams() {
  return listIndexableRegions()
    .filter((r) => !r.parent)
    .map((r) => ({ country: r.country, region: r.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ country: string; region: string }>;
}): Promise<Metadata> {
  const { country: rawCountry, region: rawRegion } = await params;
  const country = normalizeCountryParam(rawCountry);
  const region = normalizeSlugParam(rawRegion);
  const r = findRegion(country, region);
  // Sub-regions have their own 3-level page — refuse to render them here so a
  // request like /roads/best/at/alpine-passes doesn't duplicate the canonical
  // /roads/best/at/tyrol/alpine-passes page with conflicting metadata.
  if (!r || r.parent) return {};
  const title = `Best motorcycle roads in ${r.name} — Tarmoto`;
  return buildBestRoadsMetadata({
    title,
    description: r.description,
    canonicalPath: `/roads/best/${r.country}/${r.slug}`,
    imageAlt: `Best motorcycle roads in ${r.name}`,
  });
}

export default async function BestRoadsRegionPage({
  params,
}: {
  params: Promise<{ country: string; region: string }>;
}) {
  const { country: rawCountry, region: rawRegion } = await params;
  const country = normalizeCountryParam(rawCountry);
  const region = normalizeSlugParam(rawRegion);
  const regionMeta = findRegion(country, region);
  const countryMeta = findCountry(country);
  // Mirror the generateMetadata guard: sub-regions live under a 3-level URL.
  if (!regionMeta || !countryMeta || regionMeta.parent) notFound();

  const payload = await fetchBestRoads(country, region, 10);
  if (!payload) notFound();

  const pageUrl = `${siteUrl()}/roads/best/${country}/${region}`;

  return (
    <BestRoadsPageBody
      region={regionMeta}
      country={countryMeta}
      pageUrl={pageUrl}
      roads={payload.roads}
    />
  );
}
