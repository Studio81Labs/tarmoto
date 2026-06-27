import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { OverviewScreen } from "./OverviewScreen.js";

const mockUseAdminMetrics = vi.fn();

vi.mock("../data/useAdminMetrics.js", () => ({
  useAdminMetrics: () => mockUseAdminMetrics(),
}));

describe("OverviewScreen", () => {
  it("renders the metric values", () => {
    mockUseAdminMetrics.mockReturnValue({
      data: { users: 128, activeRides: 4, featureFlags: 0, closures: 7 },
      isPending: false,
      error: null,
    });
    render(<OverviewScreen />);
    expect(screen.getByText("128")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("Users")).toBeInTheDocument();
    expect(screen.getByText("Closures")).toBeInTheDocument();
  });

  it("shows placeholder dashes while pending", () => {
    mockUseAdminMetrics.mockReturnValue({
      data: undefined,
      isPending: true,
      error: null,
    });
    render(<OverviewScreen />);
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(4);
  });

  it("shows an error message on failure", () => {
    mockUseAdminMetrics.mockReturnValue({
      data: undefined,
      isPending: false,
      error: new Error("Network error"),
    });
    render(<OverviewScreen />);
    expect(screen.getByText("Failed to load metrics.")).toBeInTheDocument();
  });
});
