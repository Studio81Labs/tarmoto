import { t } from "@/i18n";
import Link from "next/link";
import { COUNTRIES, findCountryRegions } from "@tarmoto/shared";
export const revalidate = 604800;
export default function BestRoadsHubPage() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-10 text-slate-100">
      <header className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">
          {t("Best motorcycle roads ")}
        </h1>
        <p className="mt-2 text-slate-400">
          {t(
            "Browse curated lists of top-ranked roads \u2014 scored from live road quality and curviness data. Pick a country to get started. ",
          )}
        </p>
      </header>

      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {COUNTRIES.map((country) => {
          const regionCount = findCountryRegions(country.code).length;
          return (
            <li key={country.code}>
              <Link
                href={`/roads/best/${country.code}`}
                className="block rounded-xl border border-slate-800 bg-slate-900/60 p-5 hover:bg-slate-800/60 transition"
              >
                <h2 className="text-xl font-semibold">{country.name}</h2>
                <p className="mt-1 text-sm text-slate-400">
                  {regionCount}
                  {t("region")}
                  {regionCount === 1 ? "" : "s"}
                </p>
              </Link>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
