import { render } from "@testing-library/react";

vi.mock("@/i18n/server", () => ({
  readLocale: vi.fn(async () => "en"),
  t: (key: string) => key,
}));
vi.mock("@/format/server", () => ({
  getServerFormatters: vi.fn(async () => ({
    decimal: (v: number) => String(v),
    distanceKm: (v: number) => `${v} km`,
    number: (v: number) => String(v),
    month: () => "month",
  })),
}));
vi.mock("@/lib/site", () => ({ siteUrl: () => "https://tarmoto.com" }));

const fetchBestRoadsMock = vi.fn();
// `stripRoadQuality` stays REAL — it is the thing under test here.
vi.mock("@/lib/bestRoads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/bestRoads")>()),
  fetchBestRoads: (...a: unknown[]) => fetchBestRoadsMock(...a),
}));

const serverKillSwitchMock = vi.fn();
vi.mock("@/lib/serverFlags", () => ({
  serverKillSwitch: (k: string) => serverKillSwitchMock(k),
}));

// Capture what actually crosses into the page body — the roads handed on to
// the `"use client"` map live here.
const bodyProps = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./_components/BestRoadsPageBody", () => ({
  BestRoadsPageBody: (props: unknown) => {
    bodyProps.current = props;
    return <div data-testid="body" />;
  },
}));

import BestRoadsRegionPage from "./page";

const road = (overrides: Record<string, unknown> = {}) => ({
  id: "seg-1",
  road_name: "Silvretta",
  road_number: null,
  quality_score: 4.7,
  curviness_score: 3.2,
  surface_type: "asphalt",
  length_m: 22000,
  confidence: 0.8,
  geometry: [
    { lat: 47.0, lng: 10.0 },
    { lat: 47.1, lng: 10.1 },
  ],
  ...overrides,
});

const params = Promise.resolve({ country: "at", region: "tyrol" });

function roadsHandedDown(): Record<string, unknown>[] {
  return (bodyProps.current as { roads: Record<string, unknown>[] }).roads;
}

describe("BestRoadsRegionPage — road_quality_overlay", () => {
  beforeEach(() => {
    fetchBestRoadsMock.mockReset();
    serverKillSwitchMock.mockReset();
    bodyProps.current = null;
    fetchBestRoadsMock.mockResolvedValue({ roads: [road()] });
  });

  it("passes the quality score through when the flag is live", async () => {
    serverKillSwitchMock.mockResolvedValue(true);
    render(await BestRoadsRegionPage({ params }));
    expect(roadsHandedDown()[0]).toHaveProperty("quality_score", 4.7);
  });

  it("REMOVES the key from the data when the operator kills the overlay", async () => {
    serverKillSwitchMock.mockResolvedValue(false);
    render(await BestRoadsRegionPage({ params }));

    const [first] = roadsHandedDown();
    // Not `null` — ABSENT. These roads are serialized into the RSC Flight
    // payload embedded in the HTML on their way to the client map, so a null
    // placeholder would leave `quality_score` sitting in `view-source:`.
    expect(first).not.toHaveProperty("quality_score");
    expect(Object.keys(first!)).not.toContain("quality_score");
    // The row still carries everything the page needs to render without it.
    expect(first).toHaveProperty("curviness_score", 3.2);
    expect(first).toHaveProperty("length_m", 22000);
  });

  it("leaves no trace of the score anywhere in the serialized props", async () => {
    serverKillSwitchMock.mockResolvedValue(false);
    render(await BestRoadsRegionPage({ params }));

    // The assertion that matters: a DOM-text check passes while the score sits
    // in the payload. Serialize everything crossing the boundary and look for
    // both the field name and the value.
    const serialized = JSON.stringify(bodyProps.current);
    expect(serialized).not.toContain("quality_score");
    expect(serialized).not.toContain("4.7");
  });

  it("gates on the road_quality_overlay switch specifically", async () => {
    serverKillSwitchMock.mockResolvedValue(true);
    render(await BestRoadsRegionPage({ params }));
    expect(serverKillSwitchMock).toHaveBeenCalledWith("road_quality_overlay");
  });

  it("still renders the page when the flag lookup fails (fail-safe)", async () => {
    // `serverKillSwitch` answers `true` on any flags failure — a backend blip
    // must not blank a public SEO page. Asserted here as the PAGE-level
    // consequence, not just the helper's return value.
    serverKillSwitchMock.mockResolvedValue(true);
    const { getByTestId } = render(await BestRoadsRegionPage({ params }));
    expect(getByTestId("body")).toBeInTheDocument();
    expect(roadsHandedDown()[0]).toHaveProperty("quality_score", 4.7);
  });
});
