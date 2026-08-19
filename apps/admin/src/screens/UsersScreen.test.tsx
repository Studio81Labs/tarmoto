import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UsersScreen } from "./UsersScreen.js";

const mockDeleteMutate = vi.fn();
const mockRestoreMutate = vi.fn();
const mockRefetch = vi.fn();
const mockUseAdminUsersList = vi.fn();
const mockUseAdminUserDetail = vi.fn();
const mockUseAdminUserNotificationPrefs = vi.fn();
const mockUpdatePrefsMutate = vi.fn();

vi.mock("../data/useAdminUsers.js", () => ({
  useAdminUsersList: (params: unknown) => mockUseAdminUsersList(params),
  useAdminUserDetail: (id: unknown) => mockUseAdminUserDetail(id),
  useSoftDeleteUser: () => ({ mutate: mockDeleteMutate, isPending: false }),
  useRestoreUser: () => ({ mutate: mockRestoreMutate, isPending: false }),
  useAdminUserNotificationPrefs: (id: unknown) =>
    mockUseAdminUserNotificationPrefs(id),
  useUpdateUserNotificationPrefs: () => ({
    mutate: mockUpdatePrefsMutate,
    isPending: false,
  }),
}));

const mockSetOverrideMutate = vi.fn();
const mockRemoveOverrideMutate = vi.fn();
const mockUseAdminUserFeatureFlags = vi.fn();
const mockSetLimitOverrideMutate = vi.fn();
const mockRemoveLimitOverrideMutate = vi.fn();
const mockUseAdminUserFeatureLimits = vi.fn();

vi.mock("../data/useAdminFlags.js", () => ({
  useAdminUserFeatureFlags: (userId: unknown) =>
    mockUseAdminUserFeatureFlags(userId),
  useSetFeatureOverride: () => ({
    mutate: mockSetOverrideMutate,
    isPending: false,
  }),
  useRemoveFeatureOverride: () => ({
    mutate: mockRemoveOverrideMutate,
    isPending: false,
  }),
  useAdminUserFeatureLimits: (userId: unknown) =>
    mockUseAdminUserFeatureLimits(userId),
  useSetLimitOverride: () => ({
    mutate: mockSetLimitOverrideMutate,
    isPending: false,
  }),
  useRemoveLimitOverride: () => ({
    mutate: mockRemoveLimitOverrideMutate,
    isPending: false,
  }),
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
    mockSetOverrideMutate.mockClear();
    mockRemoveOverrideMutate.mockClear();
    mockUseAdminUserFeatureFlags.mockClear();
    mockSetLimitOverrideMutate.mockClear();
    mockRemoveLimitOverrideMutate.mockClear();
    mockUseAdminUserFeatureLimits.mockClear();
    mockUseAdminUserNotificationPrefs.mockClear();
    mockUpdatePrefsMutate.mockClear();

    mockUseAdminUsersList.mockReturnValue(defaultListReturn());
    mockUseAdminUserDetail.mockReturnValue({
      data: null,
      isPending: false,
      error: null,
    });
    mockUseAdminUserFeatureFlags.mockReturnValue({
      data: null,
      isPending: false,
      error: null,
      refetch: vi.fn(),
    });
    mockUseAdminUserFeatureLimits.mockReturnValue({
      data: null,
      isPending: false,
      error: null,
      refetch: vi.fn(),
    });
    mockUseAdminUserNotificationPrefs.mockReturnValue({
      data: {
        email_digest: "weekly",
        marketing_emails: false,
        quiet_hours_start: 0,
        quiet_hours_end: 0,
        quiet_hours_timezone: "UTC",
        categories: {},
      },
      isPending: false,
      error: null,
      refetch: vi.fn(),
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

  // ── Fix 1: Action error surfacing ─────────────────────────────────────────

  it("shows the server error message in an alert when delete mutation fails", async () => {
    const user = userEvent.setup();
    render(<UsersScreen />);

    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(mockDeleteMutate).toHaveBeenCalledOnce();
    const [, options] = mockDeleteMutate.mock.calls[0] as [
      unknown,
      { onError: (err: unknown) => void },
    ];

    act(() => {
      options.onError({
        statusCode: 403,
        message: "User cannot be deleted: active subscription.",
      });
    });

    expect(
      screen.getByText("User cannot be deleted: active subscription."),
    ).toBeInTheDocument();
  });

  it("shows the fallback message when delete mutation fails without a server message", async () => {
    const user = userEvent.setup();
    render(<UsersScreen />);

    await user.click(screen.getByRole("button", { name: "Delete" }));

    const [, options] = mockDeleteMutate.mock.calls[0] as [
      unknown,
      { onError: (err: unknown) => void },
    ];

    act(() => {
      options.onError({ statusCode: 500 });
    });

    expect(screen.getByText("Failed to soft-delete user.")).toBeInTheDocument();
  });

  it("shows the server error message in an alert when restore mutation fails", async () => {
    const user = userEvent.setup();
    render(<UsersScreen />);

    await user.click(screen.getByRole("button", { name: "Restore" }));

    expect(mockRestoreMutate).toHaveBeenCalledOnce();
    const [, options] = mockRestoreMutate.mock.calls[0] as [
      unknown,
      { onError: (err: unknown) => void },
    ];

    act(() => {
      options.onError({
        statusCode: 404,
        message: "User not found.",
      });
    });

    expect(screen.getByText("User not found.")).toBeInTheDocument();
  });

  it("clears the action error on a subsequent successful action", async () => {
    const user = userEvent.setup();
    render(<UsersScreen />);

    // First: trigger a delete error
    await user.click(screen.getByRole("button", { name: "Delete" }));
    const [, deleteOptions] = mockDeleteMutate.mock.calls[0] as [
      unknown,
      {
        onError: (err: unknown) => void;
        onSuccess: () => void;
        onSettled: () => void;
      },
    ];
    act(() => {
      deleteOptions.onError({ statusCode: 500, message: "Something broke." });
      // onSettled resets pendingId so the button is no longer in loading state
      deleteOptions.onSettled();
    });
    expect(screen.getByText("Something broke.")).toBeInTheDocument();

    // Second: simulate a successful delete
    mockDeleteMutate.mockClear();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    const [, deleteOptions2] = mockDeleteMutate.mock.calls[0] as [
      unknown,
      { onSuccess: () => void },
    ];
    act(() => {
      deleteOptions2.onSuccess();
    });

    expect(screen.queryByText("Something broke.")).not.toBeInTheDocument();
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
      Record<string, unknown> | undefined;
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
        plan_source: "founder",
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
    const firstViewButton = viewButtons[0];
    if (!firstViewButton) throw new Error("expected at least one View button");
    await user.click(firstViewButton);

    // Detail panel should now be visible with activity counts
    expect(screen.getByText("Rides: 42")).toBeInTheDocument();
    expect(screen.getByText("Hazard reports: 3")).toBeInTheDocument();
    expect(screen.getByText("Road reviews: 7")).toBeInTheDocument();

    // Plan source renders after the subscription tier; founder grants get a pill.
    expect(screen.getByText("Plan source")).toBeInTheDocument();
    expect(screen.getByText("founder")).toBeInTheDocument();
  });

  // ── Feature flags card ────────────────────────────────────────────────────

  it("renders the selected user's feature flags with grant/revoke/reset controls", async () => {
    mockUseAdminUserFeatureFlags.mockReturnValue({
      data: {
        user_id: "u1",
        flags: [
          {
            feature: "gpx_export",
            description: "Export rides as GPX",
            default_value: false,
            resolved: true,
            override_state: "force_on",
          },
          {
            feature: "commuter_mode",
            description: "Commuter mode tools",
            default_value: true,
            resolved: true,
            override_state: "default",
          },
        ],
      },
      isPending: false,
      error: null,
      refetch: vi.fn(),
    });

    const user = userEvent.setup();
    render(<UsersScreen />);

    await user.click(screen.getAllByRole("button", { name: "View" })[0]!);

    expect(mockUseAdminUserFeatureFlags).toHaveBeenLastCalledWith("u1");
    expect(screen.getByText("gpx_export")).toBeInTheDocument();
    expect(screen.getByText("force_on")).toBeInTheDocument();

    // Reset is only offered for the flag with an active override.
    expect(
      screen.getAllByRole("button", { name: "Reset to default" }),
    ).toHaveLength(1);

    // Grant force-enables the flag for this user.
    await user.click(screen.getAllByRole("button", { name: "Grant" })[1]!);
    expect(mockSetOverrideMutate).toHaveBeenCalledWith(
      {
        params: { path: { userId: "u1", feature: "commuter_mode" } },
        body: { enabled: true },
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );

    // Revoke force-disables it.
    await user.click(screen.getAllByRole("button", { name: "Revoke" })[0]!);
    expect(mockSetOverrideMutate).toHaveBeenCalledWith(
      {
        params: { path: { userId: "u1", feature: "gpx_export" } },
        body: { enabled: false },
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );

    // Settle the in-flight revoke so the row's buttons leave loading state.
    const [, revokeOptions] = mockSetOverrideMutate.mock.calls[1] as [
      unknown,
      { onSettled: () => void },
    ];
    act(() => {
      revokeOptions.onSettled();
    });

    // Reset removes the per-user override.
    await user.click(screen.getByRole("button", { name: "Reset to default" }));
    expect(mockRemoveOverrideMutate).toHaveBeenCalledWith(
      { params: { path: { userId: "u1", feature: "gpx_export" } } },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  // ── Feature limits card ───────────────────────────────────────────────────

  it("renders the selected user's feature limits with the resolved value (∞ for null) and no override controls when inactive", async () => {
    mockUseAdminUserFeatureLimits.mockReturnValue({
      data: {
        user_id: "u1",
        limits: [
          {
            feature: "max_active_trips",
            description: "Maximum concurrent active trips",
            resolved: null,
            override_active: false,
            override_value: null,
          },
        ],
      },
      isPending: false,
      error: null,
      refetch: vi.fn(),
    });

    const user = userEvent.setup();
    render(<UsersScreen />);

    await user.click(screen.getAllByRole("button", { name: "View" })[0]!);

    expect(mockUseAdminUserFeatureLimits).toHaveBeenLastCalledWith("u1");
    expect(screen.getByText("Feature limits")).toBeInTheDocument();
    expect(screen.getByText("max_active_trips")).toBeInTheDocument();
    expect(screen.getByText("∞")).toBeInTheDocument();

    // No active override yet → no "Remove override" action offered.
    expect(
      screen.queryByRole("button", { name: "Remove override" }),
    ).not.toBeInTheDocument();
  });

  it("shows the override value in a Pill and offers Remove override when an override is active", async () => {
    mockUseAdminUserFeatureLimits.mockReturnValue({
      data: {
        user_id: "u1",
        limits: [
          {
            // resolved (3) intentionally differs from override_value (5): a
            // stricter tier/global layer can still bind even though this
            // user has a more generous per-user override on record.
            feature: "max_active_trips",
            description: "Maximum concurrent active trips",
            resolved: 3,
            override_active: true,
            override_value: 5,
          },
        ],
      },
      isPending: false,
      error: null,
      refetch: vi.fn(),
    });

    const user = userEvent.setup();
    render(<UsersScreen />);
    await user.click(screen.getAllByRole("button", { name: "View" })[0]!);

    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Remove override" }),
    ).toBeInTheDocument();
  });

  it("Set fires the set-limit-override mutation with the parsed integer value", async () => {
    mockUseAdminUserFeatureLimits.mockReturnValue({
      data: {
        user_id: "u1",
        limits: [
          {
            feature: "max_active_trips",
            description: "Maximum concurrent active trips",
            resolved: 1,
            override_active: false,
            override_value: null,
          },
        ],
      },
      isPending: false,
      error: null,
      refetch: vi.fn(),
    });

    const user = userEvent.setup();
    render(<UsersScreen />);
    await user.click(screen.getAllByRole("button", { name: "View" })[0]!);

    await user.type(
      screen.getByRole("textbox", { name: /max_active_trips/i }),
      "5",
    );
    await user.click(screen.getByRole("button", { name: "Set" }));

    expect(mockSetLimitOverrideMutate).toHaveBeenCalledWith(
      {
        params: { path: { userId: "u1", feature: "max_active_trips" } },
        body: { value: 5 },
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("Unlimited fires the set-limit-override mutation with value: null", async () => {
    mockUseAdminUserFeatureLimits.mockReturnValue({
      data: {
        user_id: "u1",
        limits: [
          {
            feature: "max_active_trips",
            description: "Maximum concurrent active trips",
            resolved: 1,
            override_active: false,
            override_value: null,
          },
        ],
      },
      isPending: false,
      error: null,
      refetch: vi.fn(),
    });

    const user = userEvent.setup();
    render(<UsersScreen />);
    await user.click(screen.getAllByRole("button", { name: "View" })[0]!);

    await user.click(screen.getByRole("button", { name: "Unlimited" }));

    expect(mockSetLimitOverrideMutate).toHaveBeenCalledWith(
      {
        params: { path: { userId: "u1", feature: "max_active_trips" } },
        body: { value: null },
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("Remove override fires the remove-limit-override mutation", async () => {
    mockUseAdminUserFeatureLimits.mockReturnValue({
      data: {
        user_id: "u1",
        limits: [
          {
            feature: "max_active_trips",
            description: "Maximum concurrent active trips",
            resolved: 5,
            override_active: true,
            override_value: 5,
          },
        ],
      },
      isPending: false,
      error: null,
      refetch: vi.fn(),
    });

    const user = userEvent.setup();
    render(<UsersScreen />);
    await user.click(screen.getAllByRole("button", { name: "View" })[0]!);

    await user.click(screen.getByRole("button", { name: "Remove override" }));

    expect(mockRemoveLimitOverrideMutate).toHaveBeenCalledWith(
      { params: { path: { userId: "u1", feature: "max_active_trips" } } },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("clears an unsubmitted draft override value when switching directly to a different user", async () => {
    mockUseAdminUserFeatureLimits.mockImplementation((userId: unknown) => ({
      data: {
        user_id: userId,
        limits: [
          {
            feature: "max_active_trips",
            description: "Maximum concurrent active trips",
            resolved: 1,
            override_active: false,
            override_value: null,
          },
        ],
      },
      isPending: false,
      error: null,
      refetch: vi.fn(),
    }));

    const user = userEvent.setup();
    render(<UsersScreen />);

    // Open u1's detail pane and type a draft value without submitting it.
    await user.click(screen.getAllByRole("button", { name: "View" })[0]!);
    await user.type(
      screen.getByRole("textbox", { name: /max_active_trips/i }),
      "7",
    );
    expect(
      screen.getByRole("textbox", { name: /max_active_trips/i }),
    ).toHaveValue("7");

    // Switch directly to u2 (u1's row now reads "Close"; only u2's row
    // still reads "View") without closing u1 first.
    await user.click(screen.getByRole("button", { name: "View" }));

    // The card must have fully remounted for u2 — the leftover "7" typed
    // for u1 must not still be sitting in the input, ready to be applied
    // to the wrong user's account.
    expect(
      screen.getByRole("textbox", { name: /max_active_trips/i }),
    ).toHaveValue("");
  });

  it("does not submit a limit override when the value input is left blank", async () => {
    mockUseAdminUserFeatureLimits.mockReturnValue({
      data: {
        user_id: "u1",
        limits: [
          {
            feature: "max_active_trips",
            description: "Maximum concurrent active trips",
            resolved: 1,
            override_active: false,
            override_value: null,
          },
        ],
      },
      isPending: false,
      error: null,
      refetch: vi.fn(),
    });

    const user = userEvent.setup();
    render(<UsersScreen />);
    await user.click(screen.getAllByRole("button", { name: "View" })[0]!);

    // No input typed — "Set" must not submit a bare 0.
    await user.click(screen.getByRole("button", { name: "Set" }));

    expect(mockSetLimitOverrideMutate).not.toHaveBeenCalled();
  });

  // ── Fix 4: Subscription filter ────────────────────────────────────────────

  it("passes the selected subscription value to the hook", async () => {
    const user = userEvent.setup();
    render(<UsersScreen />);

    // react-aria Select renders a <button> trigger; open it then click the option
    await user.click(
      screen.getByRole("button", { name: /filter by subscription/i }),
    );
    await user.click(screen.getByRole("option", { name: "Free" }));

    const lastCall = mockUseAdminUsersList.mock.calls.at(-1)?.[0] as
      Record<string, unknown> | undefined;
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
    // react-aria Select renders a <button> trigger; open it then click the option
    await user.click(
      screen.getByRole("button", { name: /filter by subscription/i }),
    );
    await user.click(screen.getByRole("option", { name: "Pro" }));

    const lastCall = mockUseAdminUsersList.mock.calls.at(-1)?.[0] as
      Record<string, unknown> | undefined;
    expect(lastCall).toMatchObject({ page: 1, subscription: "pro" });
  });

  it("edits a user's notification preferences from the detail card", async () => {
    const user = userEvent.setup();
    render(<UsersScreen />);
    await user.click(screen.getAllByRole("button", { name: "View" })[0]!);

    expect(screen.getByText("Notification preferences")).toBeInTheDocument();

    // Changing the digest cadence PATCHes just that field for the selected user.
    // react-aria Select renders a <button> trigger; open it then click the option
    await user.click(
      screen.getByRole("button", { name: /email digest cadence/i }),
    );
    await user.click(screen.getByRole("option", { name: "Never" }));
    expect(mockUpdatePrefsMutate).toHaveBeenCalledWith(
      { params: { path: { id: "u1" } }, body: { email_digest: "never" } },
      expect.anything(),
    );

    // Toggling marketing (default off) PATCHes marketing_emails: true.
    mockUpdatePrefsMutate.mockClear();
    await user.click(screen.getByRole("switch", { name: "Marketing emails" }));
    expect(mockUpdatePrefsMutate).toHaveBeenCalledWith(
      { params: { path: { id: "u1" } }, body: { marketing_emails: true } },
      expect.anything(),
    );
  });
});
