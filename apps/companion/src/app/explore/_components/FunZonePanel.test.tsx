import { render, screen } from "@testing-library/react";

// Kill switches fail SAFE (enabled until a confirmed `force_off`).
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

const fetchFunZoneDetailMock = vi.fn();
vi.mock("@/lib/discover", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discover")>()),
  fetchFunZoneDetail: (...a: unknown[]) => fetchFunZoneDetailMock(...a),
}));
vi.mock("@/i18n/I18nProvider", () => ({
  useTranslation: () => (key: string, values?: Record<string, unknown>) =>
    values
      ? key.replace(/\{(\w+)\}/g, (_m, k) => String(values[k] ?? ""))
      : key,
}));

import { FunZonePanel } from "./FunZonePanel";

const zone = {
  id: "zone-1",
  name: "Dolomites",
  composite_score: 82.5,
  road_count: 12,
  total_curve_km: 140,
  avg_quality: 4.7,
  best_season: null,
  boundary: [],
};

const detail = {
  zone,
  top_roads: [
    {
      id: "road-1",
      road_name: "Passo Sella",
      road_number: null,
      quality_score: 4.2,
      curviness_score: 3.9,
      length_m: 12000,
      surface_type: "asphalt",
    },
  ],
};

function renderPanel() {
  return render(
    <FunZonePanel zoneId="zone-1" summary={zone as never} onClose={() => {}} />,
  );
}

/** The panel renders nothing at all if its props are wrong — every "omits the
 *  quality readout" assertion would then pass while proving nothing. Anchor on
 *  something that must ALWAYS be there first. */
async function expectPanelRendered() {
  expect(await screen.findByText("Dolomites")).toBeInTheDocument();
}

describe("FunZonePanel — road_quality_overlay", () => {
  beforeEach(() => {
    killSwitch.enabled = true;
    fetchFunZoneDetailMock.mockReset();
    fetchFunZoneDetailMock.mockResolvedValue(detail);
  });

  it("shows the quality stat and the road rating while the flag is live", async () => {
    renderPanel();
    await expectPanelRendered();
    expect(screen.getByText("Quality")).toBeInTheDocument();
    expect(screen.getByText("4.7")).toBeInTheDocument();
    expect(await screen.findByText(/★ 4\.2/)).toBeInTheDocument();
  });

  it("omits both quality readouts when the operator kills the overlay", async () => {
    killSwitch.enabled = false;
    renderPanel();
    await expectPanelRendered();

    // The label goes with the number — an em dash beside "Quality" still says
    // a figure exists and is being withheld.
    expect(screen.queryByText("Quality")).not.toBeInTheDocument();
    expect(screen.queryByText("4.7")).not.toBeInTheDocument();
    expect(screen.queryByText(/★/)).not.toBeInTheDocument();
  });

  it("renders no zone detail at all under the kill", async () => {
    // The feature comes down wholesale: the page above removes the control and
    // stops the list fetch, and this panel stops requesting detail. Zones are
    // clustered from roads filtered at `quality_score >= 3.0`, so the zone SET
    // is quality-derived, not merely quality-decorated.
    killSwitch.enabled = false;
    renderPanel();
    await expectPanelRendered();

    expect(screen.queryByText(/Passo Sella/)).not.toBeInTheDocument();
    expect(screen.queryByText(/curviness/)).not.toBeInTheDocument();
  });

  it("issues NO detail request when the overlay is killed", async () => {
    // The page above already takes the feature down, so this is the second
    // gate — but it is the request carrying `top_roads[].quality_score`, and
    // an operator must be able to stop quality-specific requests, not just
    // their rendering.
    killSwitch.enabled = false;
    renderPanel();
    await expectPanelRendered();
    expect(fetchFunZoneDetailMock).not.toHaveBeenCalled();
  });

  it("issues the detail request while the flag is live", async () => {
    renderPanel();
    await expectPanelRendered();
    expect(fetchFunZoneDetailMock).toHaveBeenCalledWith(
      "zone-1",
      expect.anything(),
    );
  });

  it("drops the readouts on a live flip", async () => {
    const { rerender } = renderPanel();
    await expectPanelRendered();
    expect(screen.getByText("Quality")).toBeInTheDocument();

    killSwitch.enabled = false;
    rerender(
      <FunZonePanel
        zoneId="zone-1"
        summary={zone as never}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByText("Quality")).not.toBeInTheDocument();
  });
});
