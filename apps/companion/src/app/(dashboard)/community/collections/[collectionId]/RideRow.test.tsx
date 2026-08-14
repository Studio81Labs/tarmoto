import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const killSwitch = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/hooks/useEntitlements", () => ({
  useFeatureKillSwitch: () => ({
    enabled: killSwitch.enabled,
    isResolved: true,
  }),
}));
vi.mock("@/format/FormatProvider", async () => {
  const { createFormatters } = await import("@tarmoto/shared");
  const format = createFormatters({ locale: "en", units: "metric" });
  return { useFormat: () => format };
});
vi.mock("@/i18n/I18nProvider", () => ({
  useTranslation: () => (key: string) => key,
}));

import { RideRow } from "./page";

const ride = {
  id: "ride-1",
  name: "Alpine loop",
  started_at: "2026-05-01T08:00:00.000Z",
  distance_km: 120,
  status: "completed",
  avg_road_quality: 4.4,
};

function renderRow() {
  return render(
    <RideRow ride={ride as never} lines={undefined} onRemove={() => {}} />,
  );
}

describe("RideRow — road_quality_overlay", () => {
  beforeEach(() => {
    killSwitch.enabled = true;
  });

  it("renders the quality bars while the flag is live", () => {
    renderRow();
    // QualityBars maps 4.4 -> tier 4, same handle the other suites assert on.
    expect(screen.getByLabelText("Quality 4 of 5")).toBeInTheDocument();
  });

  it("hides them when the operator kills the overlay", () => {
    killSwitch.enabled = false;
    renderRow();
    expect(screen.queryByLabelText("Quality 4 of 5")).not.toBeInTheDocument();
    // The row itself survives — only the quality dimension goes.
    expect(screen.getByText("Alpine loop")).toBeInTheDocument();
  });
});
