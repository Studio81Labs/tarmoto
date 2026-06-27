import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { UsersScreen } from "./UsersScreen.js";

vi.mock("../data/useAdminUsers.js", () => ({
  useAdminUsersList: () => ({
    data: {
      rows: [
        {
          id: "u1",
          email: "rider@x.io",
          display_name: "Rider",
          subscription_tier: "free",
          subscription_status: "canceled",
          created_at: "2026-01-01T00:00:00Z",
          deleted_at: null,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 25,
    },
    isPending: false,
    error: null,
  }),
  useAdminUserDetail: () => ({ data: null, isPending: false, error: null }),
  useSoftDeleteUser: () => ({ mutate: vi.fn(), isPending: false }),
  useRestoreUser: () => ({ mutate: vi.fn(), isPending: false }),
}));

describe("UsersScreen", () => {
  it("renders the user rows", () => {
    render(<UsersScreen />);
    expect(screen.getByText("rider@x.io")).toBeInTheDocument();
    expect(screen.getByText("Rider")).toBeInTheDocument();
  });
});
