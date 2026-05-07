import { t } from "@/i18n";
import Link from "next/link";
import { findSubRegions, type Country, type Region } from "@tarmoto/shared";
import { BestRoadsMap } from "./BestRoadsMap";
import { BestRoadsEmbedPanel } from "./BestRoadsEmbedPanel";
import { BestRoadsList } from "./BestRoadsList";
import { BestRoadsSchemaOrg } from "./BestRoadsSchemaOrg";
interface Road {
  id: string;
  road_name: string | null;
  road_number: string | null;
  quality_score: number | null;
  curviness_score: number;
  surface_type: string;
  length_m: number;
  confidence: number;
  geometry: {
    lat: number;
    lng: number;
  }[];
}
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
export function BestRoadsPageBody({
  region,
  country,
  parent,
  pageUrl,
  roads,
}: Props) {
  const segmentIds = roads.map((r) => r.id).join(",");
  // Sub-regions live at 3-level URLs, so a top-level region page links down
  // to its children here — otherwise those sub-region pages are only
  // reachable via the sitemap.
  const subRegions = parent ? [] : findSubRegions(country.code, region.slug);
  const origin = new URL(pageUrl).origin;
  return (
    <main className="mx-auto max-w-5xl px-6 py-10 text-slate-100">
      <nav className="mb-4 text-sm text-slate-400">
        <Link href="/roads/best" className="hover:text-white">
          {t("Best roads ")}
        </Link>
        <span className="mx-2">/</span>
        <Link href={`/roads/best/${country.code}`} className="hover:text-white">
          {country.name}
        </Link>
        {parent && (
          <>
            <span className="mx-2">/</span>
            <Link
              href={`/roads/best/${country.code}/${parent.slug}`}
              className="hover:text-white"
            >
              {parent.name}
            </Link>
          </>
        )}
        <span className="mx-2">/</span>
        <span>{region.name}</span>
      </nav>

      <header className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">
          {t("Best motorcycle roads in ")}
          {region.name}
        </h1>
        <p className="mt-3 max-w-3xl text-slate-300">{region.description}</p>
        {region.bestSeason && (
          <p className="mt-2 text-sm text-slate-500">
            {t("Best season: ")}
            {region.bestSeason}
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

      <BestRoadsEmbedPanel
        origin={origin}
        country={country.code}
        region={parent?.slug ?? region.slug}
        subregion={parent ? region.slug : undefined}
        regionName={region.name}
      />

      {subRegions.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-4 text-xl font-semibold">{t("Sub-regions")}</h2>
          <ul className="grid gap-4 sm:grid-cols-2">
            {subRegions.map((sr) => (
              <li key={sr.slug}>
                <Link
                  href={`/roads/best/${country.code}/${region.slug}/${sr.slug}`}
                  className="block rounded-xl border border-slate-800 bg-slate-900/60 p-5 hover:bg-slate-800/60 transition"
                >
                  <h3 className="text-lg font-semibold">{sr.name}</h3>
                  <p className="mt-1 text-sm text-slate-400 line-clamp-2">
                    {sr.description}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {roads.length > 0 && (
        <section className="mb-12 rounded-xl border border-slate-800 bg-slate-900/60 p-6">
          <h2 className="text-lg font-semibold">
            {t("Plan a trip with these roads ")}
          </h2>
          <p className="mt-2 text-sm text-slate-400">
            {t(
              "Pre-load this list into your trip planner to build a multi-day ride around them. ",
            )}
          </p>
          <Link
            href={`/trip-planner?segments=${segmentIds}`}
            className="mt-4 inline-flex items-center rounded-lg bg-tarmoto-cyan px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-tarmoto-cyan/90 transition"
          >
            {t("Plan a trip with these roads ")}
          </Link>
        </section>
      )}

      <BestRoadsSchemaOrg
        regionName={region.name}
        countryName={country.name}
        countryCode={country.code}
        regionSlug={region.slug}
        parentSlug={parent?.slug}
        parentName={parent?.name}
        pageUrl={pageUrl}
        description={region.description}
        roads={roads}
      />
    </main>
  );
}
