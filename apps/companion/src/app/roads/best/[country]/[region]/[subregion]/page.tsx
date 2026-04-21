import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { findCountry, findRegion, listIndexableRegions } from "@tarmoto/shared";
import { fetchBestRoads } from "@/lib/bestRoads";
import { siteUrl } from "@/lib/site";
import { BestRoadsMap } from "../_components/BestRoadsMap";
import { BestRoadsList } from "../_components/BestRoadsList";
import { BestRoadsSchemaOrg } from "../_components/BestRoadsSchemaOrg";

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

  const roads = payload.roads;
  const segmentIds = roads.map((r) => r.id).join(",");
  const pageUrl = `${siteUrl()}/roads/best/${country}/${parentSlug}/${subregion}`;

  return (
    <main className="mx-auto max-w-5xl px-6 py-10 text-slate-100">
      <nav className="mb-4 text-sm text-slate-400">
        <Link href="/roads/best" className="hover:text-white">
          Best roads
        </Link>
        <span className="mx-2">/</span>
        <Link href={`/roads/best/${country}`} className="hover:text-white">
          {countryMeta.name}
        </Link>
        <span className="mx-2">/</span>
        <Link
          href={`/roads/best/${country}/${parentSlug}`}
          className="hover:text-white"
        >
          {parentMeta.name}
        </Link>
        <span className="mx-2">/</span>
        <span>{regionMeta.name}</span>
      </nav>

      <header className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">
          Best motorcycle roads in {regionMeta.name}
        </h1>
        <p className="mt-3 max-w-3xl text-slate-300">
          {regionMeta.description}
        </p>
        {regionMeta.bestSeason && (
          <p className="mt-2 text-sm text-slate-500">
            Best season: {regionMeta.bestSeason}
          </p>
        )}
      </header>

      <section className="mb-8">
        <BestRoadsMap
          bbox={regionMeta.bbox}
          center={regionMeta.center}
          defaultZoom={regionMeta.defaultZoom}
          roads={roads}
        />
      </section>

      <section className="mb-8">
        <h2 className="mb-4 text-xl font-semibold">Ranked roads</h2>
        <BestRoadsList roads={roads} />
      </section>

      {roads.length > 0 && (
        <section className="mb-12 rounded-xl border border-slate-800 bg-slate-900/60 p-6">
          <h2 className="text-lg font-semibold">
            Plan a trip with these roads
          </h2>
          <p className="mt-2 text-sm text-slate-400">
            Pre-load this list into your trip planner to build a multi-day ride
            around them.
          </p>
          <Link
            href={`/trip-planner?segments=${segmentIds}`}
            className="mt-4 inline-flex items-center rounded-lg bg-tarmoto-cyan px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-tarmoto-cyan/90 transition"
          >
            Plan a trip with these roads
          </Link>
        </section>
      )}

      <BestRoadsSchemaOrg
        regionName={regionMeta.name}
        countryName={countryMeta.name}
        countryCode={countryMeta.code}
        regionSlug={regionMeta.slug}
        parentSlug={parentSlug}
        parentName={parentMeta.name}
        pageUrl={pageUrl}
        description={regionMeta.description}
        roads={roads}
      />
    </main>
  );
}
