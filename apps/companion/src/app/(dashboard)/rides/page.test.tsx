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

// RideExportMenu (rendered via headerRight) now calls useFeature/useEntitlements,
// which hit react-query — mock the barrel so it doesn't need a QueryClient.
// gpx_export enabled keeps the pre-gate export-menu assertions unchanged.
vi.mock("@/hooks", () => ({
  useFeature: () => ({ enabled: true, isLoading: false }),
  useEntitlements: () => ({ tier: "free" }),
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

describe("RidesPage — header Export menu", () => {
  beforeEach(() => {
    hookState.window = "all";
    hookState.total = 5;
    hookState.loading = false;
    hookState.error = null;
  });

  it("renders the Export menu trigger when the rider has rides", () => {
    render(<RidesPage />);
    expect(screen.getByRole("button", { name: "Export" })).toBeInTheDocument();
  });

  it("hides the header action on the pristine-empty account state", () => {
    hookState.total = 0;
    render(<RidesPage />);
    expect(screen.queryByRole("button", { name: "Export" })).toBeNull();
  });
});
