import { t } from "@/i18n";
import { readLocale } from "@/i18n/server";
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
  const title = t(
    "Best motorcycle roads in {name} — Tarmoto",
    { name: r.name },
    locale,
  );
  const url = `/roads/best/${r.country}/${r.parent}/${r.slug}`;
  return buildBestRoadsMetadata({
    title,
    // `r.description` is catalog data from `@tarmoto/shared` (not UI-chrome
    // copy) — excluded from t() wrapping; see the i18n readiness plan.
    description: r.description,
    canonicalPath: url,
    imageAlt: t("Best motorcycle roads in {name}", { name: r.name }, locale),
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
