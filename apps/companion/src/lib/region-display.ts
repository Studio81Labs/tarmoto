import type { Country, Formatters, MonthRange, Region } from "@tarmoto/shared";
import type { Translate } from "@/i18n";

export function countryDisplayName(country: Country, t: Translate): string {
  return t(country.nameKey);
}

export function regionDisplayName(region: Region, t: Translate): string {
  return t(region.nameKey);
}

export function regionDescription(region: Region, t: Translate): string {
  return t(region.descriptionKey);
}

export function formatBestSeason(
  range: MonthRange,
  format: Formatters,
  t: Translate,
): string {
  const start = format.month(new Date(Date.UTC(2024, range.start - 1, 1)));
  const end = format.month(new Date(Date.UTC(2024, range.end - 1, 1)));
  return t("{start} – {end}", { start, end });
}
