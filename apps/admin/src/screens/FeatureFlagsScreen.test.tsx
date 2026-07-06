import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeatureFlagsScreen } from "./FeatureFlagsScreen.js";

const mockSetGlobal = vi.fn();
const mockClearGlobal = vi.fn();
const mockRefetch = vi.fn();
const mockUseAdminFeatureFlags = vi.fn();
const mockUseAdminFeatureFlagUsers = vi.fn();

vi.mock("../data/useAdminFlags.js", () => ({
  useAdminFeatureFlags: () => mockUseAdminFeatureFlags(),
  useSetFeatureGlobal: () => ({ mutate: mockSetGlobal, isPending: false }),
  useClearFeatureGlobal: () => ({ mutate: mockClearGlobal, isPending: false }),
  useAdminFeatureFlagUsers: (
    feature: unknown,
    params: unknown,
    enabled: unknown,
  ) => mockUseAdminFeatureFlagUsers(feature, params, enabled),
}));

const mockSetLaunchTier = vi.fn();
const mockLaunchRefetch = vi.fn();
const mockUseLaunchTier = vi.fn();

vi.mock("../data/useAdminSystemSettings.js", () => ({
  useLaunchTier: () => mockUseLaunchTier(),
  useSetLaunchTier: () => ({ mutate: mockSetLaunchTier, isPending: false }),
}));

const FLAGS = [
  {
    feature: "gpx_export",
    description: "Export rides as GPX",
    default_value: false,
    tiers: ["premium", "pro"],
    global_state: null,
    global_reason: null,
    global_updated_by: null,
    global_updated_at: null,
    overridden_user_count: 3,
  },
  {
    feature: "commuter_mode",
    description: "Commuter mode tools",
    default_value: true,
    tiers: [],
    global_state: "force_off",
    global_reason: "Incident 42",
    global_updated_by: "admin-1",
    global_updated_at: "2026-06-01T00:00:00Z",
    overridden_user_count: 0,
  },
];

function defaultListReturn() {
  return {
    data: { flags: FLAGS },
    isPending: false,
    error: null,
    refetch: mockRefetch,
  };
}

describe("FeatureFlagsScreen", () => {
  beforeEach(() => {
    mockSetGlobal.mockClear();
    mockClearGlobal.mockClear();
    mockRefetch.mockClear();
    mockUseAdminFeatureFlags.mockClear();
    mockUseAdminFeatureFlagUsers.mockClear();

    mockSetLaunchTier.mockClear();
    mockLaunchRefetch.mockClear();
    mockUseLaunchTier.mockClear();

    mockUseAdminFeatureFlags.mockReturnValue(defaultListReturn());
    mockUseAdminFeatureFlagUsers.mockReturnValue({
      data: { rows: [], total: 0, page: 1, pageSize: 25 },
      isPending: false,
      error: null,
    });
    mockUseLaunchTier.mockReturnValue({
      data: { tier: null, updated_by: null, updated_at: null },
      isPending: false,
      error: null,
      refetch: mockLaunchRefetch,
    });
  });

  it("shows the loading placeholder while pending", () => {
    mockUseAdminFeatureFlags.mockReturnValue({
      data: undefined,
      isPending: true,
      error: null,
      refetch: mockRefetch,
    });
    render(<FeatureFlagsScreen />);
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("gpx_export")).not.toBeInTheDocument();
  });

  it("renders the registry rows with tiers, default and global state", () => {
    render(<FeatureFlagsScreen />);
    expect(screen.getByText("gpx_export")).toBeInTheDocument();
    expect(screen.getByText("Export rides as GPX")).toBeInTheDocument();
    expect(screen.getByText("premium")).toBeInTheDocument();
    expect(screen.getByText("pro")).toBeInTheDocument();
    expect(screen.getByText("commuter_mode")).toBeInTheDocument();
    expect(screen.getByText("force_off")).toBeInTheDocument();
    // overridden user count
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("does not offer flag creation or deletion", () => {
    render(<FeatureFlagsScreen />);
    expect(
      screen.queryByRole("button", { name: /new flag/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^delete$/i }),
    ).not.toBeInTheDocument();
  });

  it("force on calls the global mutation and refetches on success", async () => {
    render(<FeatureFlagsScreen />);
    // gpx_export (no global override) is the first row with a Force on action.
    const forceOnButtons = screen.getAllByRole("button", {
      name: "Force on",
    });
    await userEvent.click(forceOnButtons[0]!);

    expect(mockSetGlobal).toHaveBeenCalledWith(
      {
        params: { path: { feature: "gpx_export" } },
        body: { state: "force_on" },
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );

    const [, options] = mockSetGlobal.mock.calls[0] as [
      unknown,
      { onSuccess: () => void },
    ];
    act(() => {
      options.onSuccess();
    });
    expect(mockRefetch).toHaveBeenCalled();
  });

  it("force off requires a reason before submitting", async () => {
    const user = userEvent.setup();
    render(<FeatureFlagsScreen />);

    // Only gpx_export offers Force off (commuter_mode is already force_off).
    await user.click(screen.getByRole("button", { name: "Force off" }));
    const dialog = screen.getByRole("dialog");

    // Submitting without a reason blocks the mutation and shows an error.
    await user.click(within(dialog).getByRole("button", { name: "Force off" }));
    expect(mockSetGlobal).not.toHaveBeenCalled();
    expect(
      screen.getByText("A reason is required to force a feature off."),
    ).toBeInTheDocument();

    // With a reason the kill switch submits.
    await user.type(
      within(dialog).getByRole("textbox", { name: /reason/i }),
      "Broken exports",
    );
    await user.click(within(dialog).getByRole("button", { name: "Force off" }));
    expect(mockSetGlobal).toHaveBeenCalledWith(
      {
        params: { path: { feature: "gpx_export" } },
        body: { state: "force_off", reason: "Broken exports" },
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );

    // Success closes the dialog and refetches.
    const [, options] = mockSetGlobal.mock.calls[0] as [
      unknown,
      { onSuccess: () => void },
    ];
    act(() => {
      options.onSuccess();
    });
    expect(mockRefetch).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("clear removes the global override for the overridden flag only", async () => {
    render(<FeatureFlagsScreen />);
    // Only commuter_mode has an active global override → a single Clear button.
    const clearButtons = screen.getAllByRole("button", { name: "Clear" });
    expect(clearButtons).toHaveLength(1);
    await userEvent.click(clearButtons[0]!);

    expect(mockClearGlobal).toHaveBeenCalledWith(
      { params: { path: { feature: "commuter_mode" } } },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );

    const [, options] = mockClearGlobal.mock.calls[0] as [
      unknown,
      { onSuccess: () => void },
    ];
    act(() => {
      options.onSuccess();
    });
    expect(mockRefetch).toHaveBeenCalled();
  });

  it("surfaces mutation errors in an alert", async () => {
    render(<FeatureFlagsScreen />);
    await userEvent.click(
      screen.getAllByRole("button", { name: "Force on" })[0]!,
    );

    const [, options] = mockSetGlobal.mock.calls[0] as [
      unknown,
      { onError: (err: unknown) => void; onSettled: () => void },
    ];
    act(() => {
      options.onError({ statusCode: 500, message: "Registry unavailable." });
      options.onSettled();
    });
    expect(screen.getByText("Registry unavailable.")).toBeInTheDocument();
  });

  it("shows the fallback error message when the server gives none", async () => {
    render(<FeatureFlagsScreen />);
    await userEvent.click(
      screen.getAllByRole("button", { name: "Force on" })[0]!,
    );

    const [, options] = mockSetGlobal.mock.calls[0] as [
      unknown,
      { onError: (err: unknown) => void; onSettled: () => void },
    ];
    act(() => {
      options.onError({ statusCode: 500 });
      options.onSettled();
    });
    expect(
      screen.getByText("Failed to force the flag on."),
    ).toBeInTheDocument();
  });

  it("shows a load error alert", () => {
    mockUseAdminFeatureFlags.mockReturnValue({
      data: undefined,
      isPending: false,
      error: new Error("boom"),
      refetch: mockRefetch,
    });
    render(<FeatureFlagsScreen />);
    expect(
      screen.getByText("Failed to load feature flags."),
    ).toBeInTheDocument();
  });

  it("expands the per-flag overridden users panel", async () => {
    mockUseAdminFeatureFlagUsers.mockReturnValue({
      data: {
        rows: [
          {
            user_id: "u1",
            email: "rider@x.io",
            display_name: "Rider",
            subscription_tier: "free",
            enabled: true,
            updated_at: "2026-05-01T00:00:00Z",
          },
        ],
        total: 1,
        page: 1,
        pageSize: 25,
      },
      isPending: false,
      error: null,
    });
    const user = userEvent.setup();
    render(<FeatureFlagsScreen />);

    expect(screen.queryByText("rider@x.io")).not.toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Overrides" })[0]!);

    expect(mockUseAdminFeatureFlagUsers).toHaveBeenLastCalledWith(
      "gpx_export",
      expect.anything(),
      true,
    );
    expect(screen.getByText("rider@x.io")).toBeInTheDocument();
    expect(screen.getByText("force_on")).toBeInTheDocument();

    // Toggling again hides the panel.
    await user.click(screen.getByRole("button", { name: "Hide overrides" }));
    expect(screen.queryByText("rider@x.io")).not.toBeInTheDocument();
  });

  // ── Launch mode card ──────────────────────────────────────────────────────

  it("shows the launch mode off state", () => {
    render(<FeatureFlagsScreen />);
    expect(screen.getByText("Launch mode")).toBeInTheDocument();
    // The state pill (not part of the "Off" button) reads "Off".
    const offPill = screen
      .getAllByText("Off")
      .find((el) => !el.closest("button"));
    expect(offPill).toBeInTheDocument();
    expect(screen.queryByText(/New registrations get/)).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "While enabled, every new registration starts on this tier (plan source: founder). Existing accounts are unaffected.",
      ),
    ).toBeInTheDocument();
  });

  it("shows the granted state with the tier and updated date", () => {
    mockUseLaunchTier.mockReturnValue({
      data: {
        tier: "premium",
        updated_by: "admin-1",
        updated_at: "2026-06-15T00:00:00Z",
      },
      isPending: false,
      error: null,
      refetch: mockLaunchRefetch,
    });
    render(<FeatureFlagsScreen />);
    expect(
      screen.getByText("New registrations get premium"),
    ).toBeInTheDocument();
    const expectedDate = new Date("2026-06-15T00:00:00Z").toLocaleDateString(
      "en-GB",
      { year: "numeric", month: "short", day: "numeric" },
    );
    expect(screen.getByText(new RegExp(expectedDate))).toBeInTheDocument();
  });

  it("grant pro puts the pro tier and refetches on success", async () => {
    render(<FeatureFlagsScreen />);
    await userEvent.click(screen.getByRole("button", { name: "Grant Pro" }));

    expect(mockSetLaunchTier).toHaveBeenCalledWith(
      { body: { tier: "pro" } },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );

    const [, options] = mockSetLaunchTier.mock.calls[0] as [
      unknown,
      { onSuccess: () => void },
    ];
    act(() => {
      options.onSuccess();
    });
    expect(mockLaunchRefetch).toHaveBeenCalled();
  });

  it("off puts a null tier", async () => {
    mockUseLaunchTier.mockReturnValue({
      data: {
        tier: "pro",
        updated_by: "admin-1",
        updated_at: "2026-06-15T00:00:00Z",
      },
      isPending: false,
      error: null,
      refetch: mockLaunchRefetch,
    });
    render(<FeatureFlagsScreen />);
    await userEvent.click(screen.getByRole("button", { name: "Off" }));

    expect(mockSetLaunchTier).toHaveBeenCalledWith(
      { body: { tier: null } },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("surfaces launch mode mutation errors in an alert", async () => {
    render(<FeatureFlagsScreen />);
    await userEvent.click(
      screen.getByRole("button", { name: "Grant Premium" }),
    );

    const [, options] = mockSetLaunchTier.mock.calls[0] as [
      unknown,
      { onError: (err: unknown) => void; onSettled: () => void },
    ];
    act(() => {
      options.onError({ statusCode: 403, message: "Permission denied." });
      options.onSettled();
    });
    expect(screen.getByText("Permission denied.")).toBeInTheDocument();
  });

  it("shows the fallback launch mode error when the server gives none", async () => {
    render(<FeatureFlagsScreen />);
    await userEvent.click(screen.getByRole("button", { name: "Grant Pro" }));

    const [, options] = mockSetLaunchTier.mock.calls[0] as [
      unknown,
      { onError: (err: unknown) => void; onSettled: () => void },
    ];
    act(() => {
      options.onError({ statusCode: 500 });
      options.onSettled();
    });
    expect(
      screen.getByText("Failed to update launch mode."),
    ).toBeInTheDocument();
  });
});
