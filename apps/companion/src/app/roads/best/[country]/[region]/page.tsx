import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { findCountry, findRegion, listIndexableRegions } from "@tarmoto/shared";
import { fetchBestRoads } from "@/lib/bestRoads";
import { siteUrl } from "@/lib/site";
import { BestRoadsMap } from "./_components/BestRoadsMap";
import { BestRoadsList } from "./_components/BestRoadsList";
import { BestRoadsSchemaOrg } from "./_components/BestRoadsSchemaOrg";

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
  const { country, region } = await params;
  const r = findRegion(country, region);
  // Sub-regions have their own 3-level page — refuse to render them here so a
  // request like /roads/best/at/alpine-passes doesn't duplicate the canonical
  // /roads/best/at/tyrol/alpine-passes page with conflicting metadata.
  if (!r || r.parent) return {};
  const title = `Best motorcycle roads in ${r.name} — Tarmoto`;
  return {
    title,
    description: r.description,
    alternates: { canonical: `/roads/best/${r.country}/${r.slug}` },
    openGraph: {
      title,
      description: r.description,
      url: `/roads/best/${r.country}/${r.slug}`,
      type: "website",
    },
  };
}

export default async function BestRoadsRegionPage({
  params,
}: {
  params: Promise<{ country: string; region: string }>;
}) {
  const { country, region } = await params;
  const regionMeta = findRegion(country, region);
  const countryMeta = findCountry(country);
  // Mirror the generateMetadata guard: sub-regions live under a 3-level URL.
  if (!regionMeta || !countryMeta || regionMeta.parent) notFound();

  const payload = await fetchBestRoads(country, region, 10);
  if (!payload) notFound();

  const roads = payload.roads;
  const segmentIds = roads.map((r) => r.id).join(",");
  const pageUrl = `${siteUrl()}/roads/best/${country}/${region}`;

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
        pageUrl={pageUrl}
        description={regionMeta.description}
        roads={roads}
      />
    </main>
  );
}
