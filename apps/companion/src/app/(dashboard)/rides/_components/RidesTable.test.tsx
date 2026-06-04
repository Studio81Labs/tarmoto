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
  it("renders a real <table> with the v2 design column headers including LEAN", () => {
    const { container } = renderTable([ride()]);
    // Semantic table — not div+ARIA roles.
    expect(container.querySelector("table")).toBeInTheDocument();
    // Header labels (sortable ones may carry a sort caret, so match loosely).
    for (const label of [
      "DATE",
      "RIDE",
      "KM",
      "DURATION",
      "AVG",
      "LEAN",
      "QUALITY",
    ]) {
      expect(
        screen.getByRole("columnheader", { name: new RegExp(label) }),
      ).toBeInTheDocument();
    }
  });

  it("renders a row whose RIDE cell links to the ride detail page", () => {
    renderTable([ride()]);
    // Real <tr> (implicit role row); the navigable control is a real link in
    // the RIDE cell — a stretched ::after overlay makes the whole row
    // clickable while keeping a single discoverable link in the a11y tree.
    const row = screen.getByText("Sunday loop").closest("tr")!;
    const link = within(row).getByRole("link", { name: /Sunday loop/ });
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
    const row = screen.getByText("No lean").closest("tr")!;
    expect(within(row).getByText("—")).toBeInTheDocument();
  });

  it("renders the empty state when there are no rides", () => {
    renderTable([], { total: 0 });
    expect(
      screen.getByText(/no rides match these filters/i),
    ).toBeInTheDocument();
  });

  it("hides the pagination footer on a single page (no dead trailing strip)", () => {
    renderTable([ride()], { total: 1, pageSize: 20 });
    expect(
      screen.queryByRole("button", { name: /next page/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/page 1 of/i)).not.toBeInTheDocument();
  });

  it("shows the pagination footer when there is more than one page", () => {
    renderTable([ride()], { total: 42, pageSize: 20 });
    expect(
      screen.getByRole("button", { name: /next page/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/page 1 of 3/i)).toBeInTheDocument();
    expect(screen.getByText("42 rides")).toBeInTheDocument();
  });
});
