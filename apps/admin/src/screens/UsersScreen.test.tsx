import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UsersScreen } from "./UsersScreen.js";

const mockDeleteMutate = vi.fn();
const mockRestoreMutate = vi.fn();
const mockRefetch = vi.fn();

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
        {
          id: "u2",
          email: "deleted@x.io",
          display_name: "Deleted User",
          subscription_tier: "pro",
          subscription_status: "canceled",
          created_at: "2026-01-02T00:00:00Z",
          deleted_at: "2026-03-01T00:00:00Z",
        },
      ],
      total: 2,
      page: 1,
      pageSize: 25,
    },
    isPending: false,
    error: null,
    refetch: mockRefetch,
  }),
  useAdminUserDetail: () => ({ data: null, isPending: false, error: null }),
  useSoftDeleteUser: () => ({ mutate: mockDeleteMutate, isPending: false }),
  useRestoreUser: () => ({ mutate: mockRestoreMutate, isPending: false }),
}));

describe("UsersScreen", () => {
  beforeEach(() => {
    mockDeleteMutate.mockClear();
    mockRestoreMutate.mockClear();
    mockRefetch.mockClear();
  });

  it("renders the user rows", () => {
    render(<UsersScreen />);
    expect(screen.getByText("rider@x.io")).toBeInTheDocument();
    expect(screen.getByText("Rider")).toBeInTheDocument();
  });

  it("calls delete mutate with the correct path param and wires onSuccess to refetch", async () => {
    const user = userEvent.setup();
    render(<UsersScreen />);

    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(mockDeleteMutate).toHaveBeenCalledOnce();
    const [body, options] = mockDeleteMutate.mock.calls[0] as [
      unknown,
      { onSuccess: () => void },
    ];
    expect(body).toEqual({ params: { path: { id: "u1" } } });

    await options.onSuccess();
    expect(mockRefetch).toHaveBeenCalledOnce();
  });

  it("calls restore mutate with the correct path param and wires onSuccess to refetch", async () => {
    const user = userEvent.setup();
    render(<UsersScreen />);

    await user.click(screen.getByRole("button", { name: "Restore" }));

    expect(mockRestoreMutate).toHaveBeenCalledOnce();
    const [body, options] = mockRestoreMutate.mock.calls[0] as [
      unknown,
      { onSuccess: () => void },
    ];
    expect(body).toEqual({ params: { path: { id: "u2" } } });

    await options.onSuccess();
    expect(mockRefetch).toHaveBeenCalledOnce();
  });
});
