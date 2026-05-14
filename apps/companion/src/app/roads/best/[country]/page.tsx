import { t } from "@/i18n";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { COUNTRIES, findCountry, findCountryRegions } from "@tarmoto/shared";
import {
  buildBestRoadsMetadata,
  normalizeCountryParam,
} from "@/lib/best-roads-metadata";
export const revalidate = 604800;
export function generateStaticParams() {
  return COUNTRIES.map((c) => ({ country: c.code }));
}
export async function generateMetadata({
  params,
}: {
  params: Promise<{
    country: string;
  }>;
}): Promise<Metadata> {
  const { country: rawCountry } = await params;
  const country = normalizeCountryParam(rawCountry);
  const c = findCountry(country);
  if (!c) return {};
  const title = `Best motorcycle roads in ${c.name} — Tarmoto`;
  const description = `Ranked lists of the top-rated motorcycle roads in ${c.name}, scored by quality and curviness.`;
  return buildBestRoadsMetadata({
    title,
    description,
    canonicalPath: `/roads/best/${c.code}`,
    imageAlt: `Best motorcycle roads in ${c.name}`,
  });
}
export default async function BestRoadsCountryPage({
  params,
}: {
  params: Promise<{
    country: string;
  }>;
}) {
  const { country: rawCountry } = await params;
  const country = normalizeCountryParam(rawCountry);
  const c = findCountry(country);
  if (!c) notFound();
  const regions = findCountryRegions(c.code);
  return (
    <div className="tarmoto-no-cream min-h-screen bg-slate-950 text-slate-100">
      <main className="mx-auto max-w-5xl px-6 py-10">
        <nav className="mb-4 text-sm text-slate-400">
          <Link href="/roads/best" className="hover:text-white">
            {t("Best roads ")}
          </Link>
          <span className="mx-2">/</span>
          <span>{c.name}</span>
        </nav>

        <header className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight">
            {t("Best motorcycle roads in ")}
            {c.name}
          </h1>
          <p className="mt-2 text-slate-400">
            {regions.length}
            {t("curated region")}
            {regions.length === 1 ? "" : "s"}
            {t(
              "\u2014 tap through for ranked roads, quality scores and a map preview. ",
            )}
          </p>
        </header>

        <ul className="grid gap-4 sm:grid-cols-2">
          {regions.map((r) => (
            <li key={r.slug}>
              <Link
                href={`/roads/best/${c.code}/${r.slug}`}
                className="block rounded-xl border border-slate-800 bg-slate-900/60 p-5 hover:bg-slate-800/60 transition"
              >
                <h2 className="text-xl font-semibold">{r.name}</h2>
                <p className="mt-1 text-sm text-slate-400 line-clamp-2">
                  {r.description}
                </p>
                {r.bestSeason && (
                  <p className="mt-2 text-xs text-slate-500">
                    {t("Best season: ")}
                    {r.bestSeason}
                  </p>
                )}
              </Link>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
