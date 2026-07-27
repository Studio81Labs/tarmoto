import { render, screen } from "@testing-library/react";
import type { RideStats } from "@tarmoto/shared";

vi.mock("@/i18n/I18nProvider", () => ({
  useTranslation:
    () => (key: string, values?: Record<string, string | number>) => {
      const rendered = Object.entries(values ?? {}).reduce(
        (message, [name, value]) =>
          message.replaceAll(`{${name}}`, String(value)),
        key,
      );
      return `⟦ !!! ${rendered} !!! ⟧`;
    },
}));

import { RideKpiCards } from "./RideKpiCards";

describe("RideKpiCards pseudo-locale smoke", () => {
  it("renders expanded catalog copy through a representative KPI surface", () => {
    const stats: RideStats = {
      total_distance_km: 1284.4,
      total_hours: 32.6,
      new_roads: 47,
      avg_quality: 4.137,
      ride_count: 8,
    };

    render(<RideKpiCards stats={stats} />);

    expect(screen.getByText("⟦ !!! Ride time !!! ⟧")).toBeInTheDocument();
    expect(screen.getByText("⟦ !!! 4.1 / 5 !!! ⟧")).toBeInTheDocument();
  });
});
