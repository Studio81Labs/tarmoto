import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeatureFlagsScreen } from "./FeatureFlagsScreen.js";

const mockUpdate = vi.fn();
const mockRefetch = vi.fn();

vi.mock("../data/useAdminFlags.js", () => ({
  useAdminFlagsList: () => ({
    data: [
      {
        id: "f1",
        key: "group_rides",
        enabled: false,
        description: "Group ride tools",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ],
    isPending: false,
    error: null,
    refetch: mockRefetch,
  }),
  useCreateFlag: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateFlag: () => ({ mutate: mockUpdate, isPending: false }),
  useDeleteFlag: () => ({ mutate: vi.fn(), isPending: false }),
}));

describe("FeatureFlagsScreen", () => {
  it("renders the flag rows", () => {
    render(<FeatureFlagsScreen />);
    expect(screen.getByText("group_rides")).toBeInTheDocument();
  });

  it("toggling a flag calls update with the negated enabled", async () => {
    render(<FeatureFlagsScreen />);
    await userEvent.click(screen.getByRole("button", { name: /enable/i }));
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { path: { id: "f1" } },
        body: { enabled: true },
      }),
      expect.anything(),
    );
  });
});
