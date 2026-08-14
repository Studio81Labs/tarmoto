import { readLocale, t } from "@/i18n/server";
import { getServerFormatters } from "@/format/server";
import Link from "next/link";
import { findSubRegions, type Country, type Region } from "@tarmoto/shared";
import { BestRoadsMap } from "./BestRoadsMap";
import { BestRoadsList } from "./BestRoadsList";
import { BestRoadsSchemaOrg } from "./BestRoadsSchemaOrg";
import type { BestRoad } from "@/lib/bestRoads";
import {
  countryDisplayName,
  formatBestSeason,
  regionDescription,
  regionDisplayName,
} from "@/lib/region-display";
import { publicLocalePath } from "@/i18n";
type Road = Pick<
  BestRoad,
  | "id"
  | "road_name"
  | "road_number"
  | "curviness_score"
  | "surface_type"
  | "length_m"
  | "confidence"
  | "geometry"
> & {
  /** Absent when the operator has killed `road_quality_overlay`. The page
   *  strips the key server-side (`stripRoadQuality`) rather than nulling it,
   *  so it never reaches the RSC Flight payload the map's props are
   *  serialized into. Optional here is what forces each consumer below to
   *  handle the absence instead of rendering a placeholder. */
  quality_score?: number | null;
};
interface Props {
  region: Region;
  country: Country;
  /** When set, renders the sub-region breadcrumb + extends the JSON-LD breadcrumbs. */
  parent?: Region;
  pageUrl: string;
  roads: Road[];
}
/**
 * Shared render body for the region and sub-region best-roads pages.
 * The two levels differ only in breadcrumb depth and a couple of Schema.org
 * props — keeping a single component means the header, map, list and CTA
 * layouts can't drift between them.
 */
export async function BestRoadsPageBody({
  region,
  country,
  parent,
  pageUrl,
  roads,
}: Props) {
  const locale = await readLocale();
  const format = await getServerFormatters();
  const displayRegionName = regionDisplayName(region, t);
  const displayCountryName = countryDisplayName(country, t);
  const displayParentName = parent ? regionDisplayName(parent, t) : undefined;
  const description = regionDescription(region, t);
  const segmentIds = roads.map((r) => r.id).join(",");
  // Sub-regions live at 3-level URLs, so a top-level region page links down
  // to its children here — otherwise those sub-region pages are only
  // reachable via the sitemap.
  const subRegions = parent ? [] : findSubRegions(country.code, region.slug);
  return (
    <div className="min-h-screen bg-cream text-ink">
      <main className="mx-auto max-w-5xl px-6 py-10">
        <nav className="mb-4 text-sm text-fg-dim">
          <Link
            href={publicLocalePath("/roads/best", locale)}
            className="hover:text-ink"
          >
            {t("Best roads")}
          </Link>
          <span className="mx-2">/</span>
          <Link
            href={publicLocalePath(`/roads/best/${country.code}`, locale)}
            className="hover:text-ink"
          >
            {displayCountryName}
          </Link>
          {parent && (
            <>
              <span className="mx-2">/</span>
              <Link
                href={publicLocalePath(
                  `/roads/best/${country.code}/${parent.slug}`,
                  locale,
                )}
                className="hover:text-ink"
              >
                {displayParentName}
              </Link>
            </>
          )}
          <span className="mx-2">/</span>
          <span>{displayRegionName}</span>
        </nav>

        <header className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight">
            {t("Best motorcycle roads in {region}", {
              region: displayRegionName,
            })}
          </h1>
          <p className="mt-3 max-w-3xl text-fg-dim">{description}</p>
          {region.bestSeason && (
            <p className="mt-2 text-sm text-fg-dim">
              {t("Best season: {season}", {
                season: formatBestSeason(region.bestSeason, format, t),
              })}
            </p>
          )}
        </header>

        <section className="mb-8">
          <BestRoadsMap
            bbox={region.bbox}
            center={region.center}
            defaultZoom={region.defaultZoom}
            roads={roads}
          />
        </section>

        <section className="mb-8">
          <h2 className="mb-4 text-xl font-semibold">{t("Ranked roads")}</h2>
          <BestRoadsList roads={roads} />
        </section>

        {subRegions.length > 0 && (
          <section className="mb-8">
            <h2 className="mb-4 text-xl font-semibold">{t("Sub-regions")}</h2>
            <ul className="grid gap-4 sm:grid-cols-2">
              {subRegions.map((sr) => (
                <li key={sr.slug}>
                  <Link
                    href={publicLocalePath(
                      `/roads/best/${country.code}/${region.slug}/${sr.slug}`,
                      locale,
                    )}
                    className="block rounded-xl border border-line bg-paper p-5 transition hover:bg-paper-2"
                  >
                    <h3 className="text-lg font-semibold">
                      {regionDisplayName(sr, t)}
                    </h3>
                    <p className="mt-1 text-sm text-fg-dim line-clamp-2">
                      {regionDescription(sr, t)}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {roads.length > 0 && (
          <section className="mb-12 rounded-xl border border-line bg-paper p-6">
            <h2 className="text-lg font-semibold">
              {t("Plan a trip with these roads")}
            </h2>
            <p className="mt-2 text-sm text-fg-dim">
              {t(
                "Pre-load this list into your trip planner to build a multi-day ride around them.",
              )}
            </p>
            <Link
              href={`/trip-planner?segments=${segmentIds}`}
              className="mt-4 inline-flex items-center rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-ink transition hover:brightness-95"
            >
              {t("Plan a trip with these roads")}
            </Link>
          </section>
        )}

        <BestRoadsSchemaOrg
          regionName={displayRegionName}
          countryName={displayCountryName}
          countryCode={country.code}
          regionSlug={region.slug}
          parentSlug={parent?.slug}
          parentName={displayParentName}
          pageUrl={pageUrl}
          description={description}
          roads={roads}
          format={format}
          t={t}
          locale={locale}
        />
      </main>
    </div>
  );
}
