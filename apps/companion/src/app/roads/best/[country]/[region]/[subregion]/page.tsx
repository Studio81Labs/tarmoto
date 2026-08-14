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
import { BestRoadsPageBody } from "../_components/BestRoadsPageBody";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ country: string; region: string; subregion: string }>;
}): Promise<Metadata> {
  const {
    country: rawCountry,
    region: rawRegion,
    subregion: rawSubregion,
  } = await params;
  const country = normalizeCountryParam(rawCountry);
  const region = normalizeSlugParam(rawRegion);
  const subregion = normalizeSlugParam(rawSubregion);
  const r = findRegion(country, subregion);
  if (!r || r.parent !== region) return {};
  const locale = await readLocale();
  const regionName = t(r.nameKey, undefined, locale);
  const title = t(
    "Best motorcycle roads in {name} — Tarmoto",
    { name: regionName },
    locale,
  );
  const url = `/roads/best/${r.country}/${r.parent}/${r.slug}`;
  return buildBestRoadsMetadata({
    title,
    description: t(r.descriptionKey, undefined, locale),
    canonicalPath: url,
    imageAlt: t(
      "Best motorcycle roads in {name}",
      { name: regionName },
      locale,
    ),
    locale,
  });
}

export default async function BestRoadsSubRegionPage({
  params,
}: {
  params: Promise<{ country: string; region: string; subregion: string }>;
}) {
  const {
    country: rawCountry,
    region: rawParentSlug,
    subregion: rawSubregion,
  } = await params;
  const country = normalizeCountryParam(rawCountry);
  const parentSlug = normalizeSlugParam(rawParentSlug);
  const subregion = normalizeSlugParam(rawSubregion);
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

  // See the region page: resolved server-side so the scores never reach the
  // HTML or the client component's serialized props.
  const qualityEnabled = await serverKillSwitch("road_quality_overlay");
  const roads = qualityEnabled
    ? payload.roads
    : stripRoadQuality(payload.roads);

  const pageUrl = `${siteUrl()}/roads/best/${country}/${parentSlug}/${subregion}`;

  return (
    <BestRoadsPageBody
      region={regionMeta}
      country={countryMeta}
      parent={parentMeta}
      pageUrl={pageUrl}
      roads={roads}
    />
  );
}
