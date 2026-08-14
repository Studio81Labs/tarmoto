import { readLocale, t } from "@/i18n/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { findCountry, findRegion } from "@tarmoto/shared";
import { fetchBestRoads, stripRoadQuality } from "@/lib/bestRoads";
import { serverKillSwitch } from "@/lib/serverFlags";
import { siteUrl } from "@/lib/site";
import {
  buildBestRoadsMetadata,
  normalizeCountryParam,
  normalizeSlugParam,
} from "@/lib/best-roads-metadata";
import { BestRoadsPageBody } from "./_components/BestRoadsPageBody";

export const dynamic = "force-dynamic";

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
  const locale = await readLocale();
  const regionName = t(r.nameKey, undefined, locale);
  const title = t(
    "Best motorcycle roads in {name} — Tarmoto",
    { name: regionName },
    locale,
  );
  return buildBestRoadsMetadata({
    title,
    description: t(r.descriptionKey, undefined, locale),
    canonicalPath: `/roads/best/${r.country}/${r.slug}`,
    imageAlt: t(
      "Best motorcycle roads in {name}",
      { name: regionName },
      locale,
    ),
    locale,
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

  // Resolve the operator kill HERE, not in the map component. This page is
  // public and `force-dynamic`, so every request re-renders and re-reads the
  // flags — a flip takes effect on the very next request, with no cache window
  // to wait out (see lib/bestRoads.ts: nothing server-side caches today). What
  // the client gate cannot do is keep the scores out of the HTML: they would
  // still be in the RSC Flight payload and readable in `view-source:`, so the
  // data is stripped before it is rendered or crosses the client boundary.
  const qualityEnabled = await serverKillSwitch("road_quality_overlay");
  const roads = qualityEnabled
    ? payload.roads
    : stripRoadQuality(payload.roads);

  const pageUrl = `${siteUrl()}/roads/best/${country}/${region}`;

  return (
    <BestRoadsPageBody
      region={regionMeta}
      country={countryMeta}
      pageUrl={pageUrl}
      roads={roads}
    />
  );
}
