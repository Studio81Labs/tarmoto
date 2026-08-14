import { render, screen } from "@testing-library/react";

vi.mock("@/i18n/server", () => ({ t: (key: string) => key }));
// Real formatters, like BestRoadsSchemaOrg's suite — a hand-rolled partial
// mock silently drifts from the `Formatters` surface the component uses.
vi.mock("@/format/server", async () => {
  const { createFormatters } = await import("@tarmoto/shared");
  const format = createFormatters({ locale: "en", units: "metric" });
  return { getServerFormatters: async () => format };
});

import { BestRoadsList } from "./BestRoadsList";

const road = {
  id: "seg-1",
  road_name: "Silvretta",
  road_number: null,
  curviness_score: 3.2,
  surface_type: "asphalt" as const,
  length_m: 22000,
  confidence: 0.8,
};

describe("BestRoadsList — road_quality_overlay", () => {
  it("renders the quality figure while the flag is live", async () => {
    render(await BestRoadsList({ roads: [{ ...road, quality_score: 4.7 }] }));
    expect(screen.getByText("Quality")).toBeInTheDocument();
    expect(screen.getByText("4.7")).toBeInTheDocument();
  });

  it("omits the whole quality cell when the score is STRIPPED", async () => {
    render(await BestRoadsList({ roads: [road] }));
    // Not an em dash in place of the number — the label goes too. A visible
    // "Quality —" still tells a visitor the figure exists and is withheld.
    expect(screen.queryByText("Quality")).not.toBeInTheDocument();
    expect(screen.queryByText("—")).not.toBeInTheDocument();
    // The row still stands on curviness + distance, so nothing 404s.
    expect(screen.getByText("Curviness")).toBeInTheDocument();
    expect(screen.getByText("3.2")).toBeInTheDocument();
    expect(screen.getByText(/22 km/)).toBeInTheDocument();
  });

  it("still shows the em dash for a NULL score while the flag is live", async () => {
    // A road with no rating yet is a fact about the road, not a kill switch.
    render(await BestRoadsList({ roads: [{ ...road, quality_score: null }] }));
    expect(screen.getByText("Quality")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
