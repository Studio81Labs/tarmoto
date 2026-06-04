import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// Mutable hook state the mocks read from, so each test can vary the
// active time window / list result without re-mocking the modules.
const hookState = {
  window: "all" as string,
  total: 5,
  loading: false,
  error: null as string | null,
};

vi.mock("./_components/useRidesQuery", () => ({
  useRidesQuery: () => ({
    state: { page: 1, sort: "started_at", order: "desc" },
    list: {
      rides: [],
      total: hookState.total,
      loading: hookState.loading,
      error: hookState.error,
    },
    update: vi.fn(),
    reset: vi.fn(),
    pageSize: 20,
  }),
  toFilterParams: () => ({}),
}));

vi.mock("./_components/TimeWindowPills", () => ({
  useTimeWindow: () => hookState.window,
}));

vi.mock("@/hooks/useRideStats", () => ({
  useRideStats: () => ({ stats: null }),
}));

// Render the scaffold inline so the header CTA slot is in the DOM, but skip
// its own data-fetching chrome (tabs bar, totals fetch).
vi.mock("./_RidesScaffold", () => ({
  RidesScaffold: ({
    headerRight,
    children,
  }: {
    headerRight?: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <div>
      {headerRight}
      {children}
    </div>
  ),
}));

vi.mock("./_components/RidesTable", () => ({
  RidesTable: () => <div data-testid="rides-table" />,
}));
vi.mock("./_components/RidesFilters", () => ({
  RidesFilters: () => null,
}));
vi.mock("./_components/RideKpiCards", () => ({
  RideKpiCards: () => null,
}));
vi.mock("./_RidesEmptyState", () => ({
  RidesEmptyState: () => null,
}));
vi.mock("@/lib/ride-export", () => ({
  downloadAllRidesExport: vi.fn(),
}));

import RidesPage from "./page";

const shareMapHref = () =>
  screen.getByRole("link", { name: /Share map/i }).getAttribute("href");

describe("RidesPage — Share map CTA carries the active window", () => {
  beforeEach(() => {
    hookState.window = "all";
    hookState.total = 5;
    hookState.loading = false;
    hookState.error = null;
  });

  it("links to the bare road map when the window is the 'all' default", () => {
    render(<RidesPage />);
    expect(shareMapHref()).toBe("/rides/road-map");
  });

  it("appends ?window= so the road map opens the same period", () => {
    hookState.window = "30d";
    render(<RidesPage />);
    expect(shareMapHref()).toBe("/rides/road-map?window=30d");
  });
});
