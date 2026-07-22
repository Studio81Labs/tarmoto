import { t } from "@/i18n/server";
import Link from "next/link";
import { COUNTRIES, findCountryRegions } from "@tarmoto/shared";
export const revalidate = 604800;
export default function BestRoadsHubPage() {
  return (
    <div className="min-h-screen bg-cream text-ink">
      <main className="mx-auto max-w-5xl px-6 py-10">
        <header className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight">
            {t("Best motorcycle roads ")}
          </h1>
          <p className="mt-2 text-fg-dim">
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
                  className="block rounded-xl border border-line bg-paper p-5 transition hover:bg-paper-2"
                >
                  <h2 className="text-xl font-semibold">
                    {t(country.nameKey)}
                  </h2>
                  <p className="mt-1 text-sm text-fg-dim">
                    {t("{count, plural, one {# region} other {# regions}}", {
                      count: regionCount,
                    })}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      </main>
    </div>
  );
}
