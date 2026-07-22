import { createFormatters, findCountry, findRegion } from "@tarmoto/shared";
import { t } from "@/i18n";
import {
  countryDisplayName,
  formatBestSeason,
  regionDescription,
  regionDisplayName,
} from "./region-display";

describe("region display copy", () => {
  it("routes names and descriptions through typed catalog keys", () => {
    const country = findCountry("at");
    const region = findRegion("at", "tyrol");
    expect(country).toBeDefined();
    expect(region).toBeDefined();
    expect(countryDisplayName(country!, t)).toBe("Austria");
    expect(regionDisplayName(region!, t)).toBe("Tyrol");
    expect(regionDescription(region!, t)).toContain("Austrian Alps");
  });

  it("formats season months with the rider's regional locale", () => {
    const format = createFormatters({ locale: "de-DE", units: "metric" });
    expect(formatBestSeason({ start: 5, end: 10 }, format, t)).toBe(
      "Mai – Okt",
    );
  });
});
