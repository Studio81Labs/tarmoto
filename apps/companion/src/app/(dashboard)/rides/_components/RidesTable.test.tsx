import { render, screen, within } from "@testing-library/react";
import { RidesTable } from "./RidesTable";
import type { RideSummary, RidesQueryState } from "./useRidesQuery";

// next/link renders a plain anchor in jsdom; stub it so we can read `href`.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

function ride(overrides: Partial<RideSummary> = {}): RideSummary {
  return {
    id: "ride-1",
    name: "Sunday loop",
    started_at: "2026-05-18T08:00:00.000Z",
    ended_at: "2026-05-18T10:30:00.000Z",
    ride_type: "trip",
    status: "completed",
    distance_km: 142.4,
    avg_speed: 63.2,
    avg_road_quality: 4.2,
    duration_min: 150,
    max_lean_angle: 38.6,
    ...overrides,
  };
}

const state: RidesQueryState = {
  sort: "started_at",
  order: "desc",
  page: 1,
};

function renderTable(
  rides: RideSummary[],
  extra: Partial<React.ComponentProps<typeof RidesTable>> = {},
) {
  return render(
    <RidesTable
      state={state}
      rides={rides}
      total={rides.length}
      pageSize={20}
      loading={false}
      onSort={vi.fn()}
      onPage={vi.fn()}
      {...extra}
    />,
  );
}

describe("RidesTable", () => {
  it("renders the v2 design column headers including LEAN", () => {
    renderTable([ride()]);
    const headers = screen
      .getAllByRole("columnheader")
      .map((h) => h.textContent?.trim());
    expect(headers).toEqual(
      expect.arrayContaining([
        "DATE",
        "RIDE",
        "KM",
        "DURATION",
        "AVG",
        "LEAN",
        "QUALITY",
      ]),
    );
  });

  it("renders a row whose RIDE cell links to the ride detail page", () => {
    renderTable([ride()]);
    // The data row carries role="row" (so does the header row); target the
    // one containing the ride name. The navigable control is a real link
    // inside the RIDE cell — a stretched ::after overlay makes the whole row
    // clickable while keeping a single discoverable link in the a11y tree.
    const row = screen
      .getByText("Sunday loop")
      .closest<HTMLElement>('[role="row"]')!;
    const link = within(row).getByRole("link", { name: "Sunday loop" });
    expect(link).toHaveAttribute("href", "/rides/ride-1");

    const cells = within(row).getAllByRole("cell");
    // RIDE name + ride_type subtext (region/hazard omitted by design).
    expect(within(row).getByText("trip")).toBeInTheDocument();
    // KM rounded, AVG (avg_speed) rounded no unit, LEAN with degree.
    expect(within(row).getByText("142")).toBeInTheDocument();
    expect(within(row).getByText("63")).toBeInTheDocument();
    expect(within(row).getByText("39°")).toBeInTheDocument();
    expect(cells).toHaveLength(8);
  });

  it("shows an em dash for a missing lean angle", () => {
    renderTable([ride({ id: "r2", name: "No lean", max_lean_angle: null })]);
    const row = screen
      .getByText("No lean")
      .closest<HTMLElement>('[role="row"]')!;
    expect(within(row).getByText("—")).toBeInTheDocument();
  });

  it("renders the empty state when there are no rides", () => {
    renderTable([], { total: 0 });
    expect(
      screen.getByText(/no rides match these filters/i),
    ).toBeInTheDocument();
  });
});
