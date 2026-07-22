import { readLocale, t } from "@/i18n/server";
import { getServerFormatters } from "@/format/server";
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
  // This page runs under weekly ISR (`revalidate` above). Background
  // regeneration has no request context, so `readLocale()` falls back to
  // `DEFAULT_LOCALE` and this metadata is served in English regardless of
  // visitor locale until locale-segmented routing exists. Acceptable today
  // (English-only, per the i18n readiness spec) and out of scope to fix here.
  const locale = await readLocale();
  const countryName = t(c.nameKey, undefined, locale);
  const title = t(
    "Best motorcycle roads in {name} — Tarmoto",
    { name: countryName },
    locale,
  );
  const description = t(
    "Ranked lists of the top-rated motorcycle roads in {name}, scored by quality and curviness.",
    { name: countryName },
    locale,
  );
  return buildBestRoadsMetadata({
    title,
    description,
    canonicalPath: `/roads/best/${c.code}`,
    imageAlt: t(
      "Best motorcycle roads in {name}",
      { name: countryName },
      locale,
    ),
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
  await readLocale();
  const format = await getServerFormatters();
  const countryName = t(c.nameKey);
  return (
    <div className="min-h-screen bg-cream text-ink">
      <main className="mx-auto max-w-5xl px-6 py-10">
        <nav className="mb-4 text-sm text-fg-dim">
          <Link href="/roads/best" className="hover:text-ink">
            {t("Best roads ")}
          </Link>
          <span className="mx-2">/</span>
          <span>{countryName}</span>
        </nav>

        <header className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight">
            {t("Best motorcycle roads in ")}
            {countryName}
          </h1>
          <p className="mt-2 text-fg-dim">
            {t(
              "{count, plural, one {# curated region} other {# curated regions}}",
              { count: regions.length },
            )}
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
                className="block rounded-xl border border-line bg-paper p-5 transition hover:bg-paper-2"
              >
                <h2 className="text-xl font-semibold">{t(r.nameKey)}</h2>
                <p className="mt-1 text-sm text-fg-dim line-clamp-2">
                  {t(r.descriptionKey)}
                </p>
                {r.bestSeason && (
                  <p className="mt-2 text-xs text-fg-dim">
                    {t("Best season: ")}
                    {t("{start} – {end}", {
                      start: format.month(
                        new Date(Date.UTC(2024, r.bestSeason.start - 1, 1)),
                      ),
                      end: format.month(
                        new Date(Date.UTC(2024, r.bestSeason.end - 1, 1)),
                      ),
                    })}
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
