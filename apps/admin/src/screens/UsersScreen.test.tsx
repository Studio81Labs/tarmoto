import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UsersScreen } from "./UsersScreen.js";

const mockDeleteMutate = vi.fn();
const mockRestoreMutate = vi.fn();
const mockRefetch = vi.fn();
const mockUseAdminUsersList = vi.fn();
const mockUseAdminUserDetail = vi.fn();

vi.mock("../data/useAdminUsers.js", () => ({
  useAdminUsersList: (params: unknown) => mockUseAdminUsersList(params),
  useAdminUserDetail: (id: unknown) => mockUseAdminUserDetail(id),
  useSoftDeleteUser: () => ({ mutate: mockDeleteMutate, isPending: false }),
  useRestoreUser: () => ({ mutate: mockRestoreMutate, isPending: false }),
}));

const BASE_ROWS = [
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
];

function defaultListReturn(overrides?: Record<string, unknown>) {
  return {
    data: {
      rows: BASE_ROWS,
      total: 2,
      page: 1,
      pageSize: 25,
      ...overrides,
    },
    isPending: false,
    error: null,
    refetch: mockRefetch,
  };
}

describe("UsersScreen", () => {
  beforeEach(() => {
    mockDeleteMutate.mockClear();
    mockRestoreMutate.mockClear();
    mockRefetch.mockClear();
    mockUseAdminUsersList.mockClear();
    mockUseAdminUserDetail.mockClear();

    mockUseAdminUsersList.mockReturnValue(defaultListReturn());
    mockUseAdminUserDetail.mockReturnValue({
      data: null,
      isPending: false,
      error: null,
    });
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

  // ── Fix 2: Pagination ──────────────────────────────────────────────────────

  it("renders Next enabled when total > pageSize and clicking Next advances the page param", async () => {
    // 75 rows across 25-per-page → 3 pages; Next should be enabled on page 1
    mockUseAdminUsersList.mockReturnValue(
      defaultListReturn({ total: 75, page: 1 }),
    );
    const user = userEvent.setup();
    render(<UsersScreen />);

    const nextBtn = screen.getByRole("button", { name: "Next" });
    expect(nextBtn).not.toBeDisabled();

    await user.click(nextBtn);

    // After clicking Next the hook should be called with page: 2
    const lastCall = mockUseAdminUsersList.mock.calls.at(-1)?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(lastCall).toMatchObject({ page: 2 });
  });

  it("renders Prev disabled on page 1", () => {
    render(<UsersScreen />);
    expect(screen.getByRole("button", { name: "Prev" })).toBeDisabled();
  });

  it("renders Next disabled when already on the last page", () => {
    // total === pageSize → 1 page
    mockUseAdminUsersList.mockReturnValue(
      defaultListReturn({ total: 2, page: 1, pageSize: 25 }),
    );
    render(<UsersScreen />);
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  // ── Fix 3: User detail view ───────────────────────────────────────────────

  it("clicking View opens the detail panel and renders activity counts", async () => {
    mockUseAdminUserDetail.mockReturnValue({
      data: {
        id: "u1",
        email: "rider@x.io",
        display_name: "Rider",
        subscription_tier: "free",
        subscription_status: "canceled",
        created_at: "2026-01-01T00:00:00Z",
        deleted_at: null,
        home_region: null,
        email_verified_at: null,
        subscription_current_period_end: null,
        subscription_cancel_at_period_end: false,
        deletion_scheduled_at: null,
        deletion_reason: null,
        activity: {
          rides: 42,
          hazardReports: 3,
          roadReviews: 7,
          trips: 2,
          commuteRoutes: 1,
        },
      },
      isPending: false,
      error: null,
    });

    const user = userEvent.setup();
    render(<UsersScreen />);

    // Detail panel must not be visible before clicking
    expect(screen.queryByText("Rides: 42")).not.toBeInTheDocument();

    // Click the View button on the first row (u1)
    const viewButtons = screen.getAllByRole("button", { name: "View" });
    await user.click(viewButtons[0]);

    // Detail panel should now be visible with activity counts
    expect(screen.getByText("Rides: 42")).toBeInTheDocument();
    expect(screen.getByText("Hazard reports: 3")).toBeInTheDocument();
    expect(screen.getByText("Road reviews: 7")).toBeInTheDocument();
  });

  // ── Fix 4: Subscription filter ────────────────────────────────────────────

  it("passes the selected subscription value to the hook", async () => {
    const user = userEvent.setup();
    render(<UsersScreen />);

    await user.selectOptions(
      screen.getByRole("combobox", { name: /filter by subscription/i }),
      "free",
    );

    const lastCall = mockUseAdminUsersList.mock.calls.at(-1)?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(lastCall).toMatchObject({ subscription: "free" });
  });

  it("resets page to 1 when the subscription filter changes", async () => {
    // Start with page 2 by clicking Next first
    mockUseAdminUsersList.mockReturnValue(
      defaultListReturn({ total: 75, page: 1 }),
    );
    const user = userEvent.setup();
    render(<UsersScreen />);

    await user.click(screen.getByRole("button", { name: "Next" }));
    // Page is now 2; re-mock so the list hook returns something for page 2
    mockUseAdminUsersList.mockReturnValue(
      defaultListReturn({ total: 75, page: 2 }),
    );

    // Changing subscription filter should reset page to 1
    await user.selectOptions(
      screen.getByRole("combobox", { name: /filter by subscription/i }),
      "pro",
    );

    const lastCall = mockUseAdminUsersList.mock.calls.at(-1)?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(lastCall).toMatchObject({ page: 1, subscription: "pro" });
  });
});
