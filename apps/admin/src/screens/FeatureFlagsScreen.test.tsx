import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeatureFlagsScreen } from "./FeatureFlagsScreen.js";

const mockSetGlobal = vi.fn();
const mockClearGlobal = vi.fn();
const mockRefetch = vi.fn();
const mockUseAdminFeatureFlags = vi.fn();
const mockUseAdminFeatureFlagUsers = vi.fn();

const mockSetLimitGlobal = vi.fn();
const mockClearLimitGlobal = vi.fn();
const mockLimitsRefetch = vi.fn();
const mockUseAdminFeatureLimits = vi.fn();

const mockDisableSwitch = vi.fn();
const mockEnableSwitch = vi.fn();
const mockSwitchesRefetch = vi.fn();
const mockUseAdminSystemSwitches = vi.fn();

vi.mock("../data/useAdminFlags.js", () => ({
  useAdminFeatureFlags: () => mockUseAdminFeatureFlags(),
  useSetFeatureGlobal: () => ({ mutate: mockSetGlobal, isPending: false }),
  useClearFeatureGlobal: () => ({ mutate: mockClearGlobal, isPending: false }),
  useAdminFeatureFlagUsers: (
    feature: unknown,
    params: unknown,
    enabled: unknown,
  ) => mockUseAdminFeatureFlagUsers(feature, params, enabled),
  useAdminFeatureLimits: () => mockUseAdminFeatureLimits(),
  useSetLimitGlobal: () => ({ mutate: mockSetLimitGlobal, isPending: false }),
  useClearLimitGlobal: () => ({
    mutate: mockClearLimitGlobal,
    isPending: false,
  }),
  useAdminSystemSwitches: () => mockUseAdminSystemSwitches(),
  useDisableSystemSwitch: () => ({
    mutate: mockDisableSwitch,
    isPending: false,
  }),
  useEnableSystemSwitch: () => ({
    mutate: mockEnableSwitch,
    isPending: false,
  }),
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

const LIMITS = [
  {
    feature: "max_active_trips",
    description: "Maximum open (draft/planned/active) trips a user may own.",
    default_value: 1,
    tier_values: { free: 1, pro: null, premium: null },
    global_active: true,
    global_value: null,
    global_reason:
      "Launch mode: unlimited for everyone until tier enforcement goes live.",
    global_updated_by: "admin-1",
    global_updated_at: "2026-06-01T00:00:00Z",
    overridden_user_count: 0,
  },
];

function defaultLimitsReturn() {
  return {
    data: { limits: LIMITS },
    isPending: false,
    error: null,
    refetch: mockLimitsRefetch,
  };
}

const SWITCHES = [
  {
    key: "sys_weather_provider",
    description: "Weather-along-route data.",
    enabled: true,
    disabled_reason: null,
    disabled_by: null,
    disabled_at: null,
  },
  {
    key: "sys_nap_routing_avoidance",
    description: "Closures injected as Valhalla exclude_polygons.",
    enabled: false,
    disabled_reason: "Valhalla polygon regression",
    disabled_by: "admin-1",
    disabled_at: "2026-06-10T00:00:00Z",
  },
];

function defaultSwitchesReturn() {
  return {
    data: { switches: SWITCHES },
    isPending: false,
    error: null,
    refetch: mockSwitchesRefetch,
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

    mockSetLimitGlobal.mockClear();
    mockClearLimitGlobal.mockClear();
    mockLimitsRefetch.mockClear();
    mockUseAdminFeatureLimits.mockClear();

    mockDisableSwitch.mockClear();
    mockEnableSwitch.mockClear();
    mockSwitchesRefetch.mockClear();
    mockUseAdminSystemSwitches.mockClear();

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
    mockUseAdminFeatureLimits.mockReturnValue(defaultLimitsReturn());
    mockUseAdminSystemSwitches.mockReturnValue(defaultSwitchesReturn());
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

  it("titles every table from inside its own table card, not a wrapping card", () => {
    render(<FeatureFlagsScreen />);
    const sections = [
      ["Flags", "Feature Flags"],
      ["Limits", "Feature Limits"],
      ["System switches", "System Switches"],
    ] as const;
    for (const [title, tableLabel] of sections) {
      // A DataTable is already a card, and it renders its `header` slot inside
      // that card, directly above the table. So the table's own container must
      // contain the section heading — if the heading were hoisted into a second
      // wrapping card around the table, the container would not.
      const tableCard = screen.getByRole("table", {
        name: tableLabel,
      }).parentElement;
      expect(tableCard).not.toBeNull();
      expect(
        within(tableCard as HTMLElement).getByRole("heading", { name: title }),
      ).toBeInTheDocument();
    }
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

  // ── Feature limits section ────────────────────────────────────────────────────

  it("renders the limits section with per-tier values and the active global override", () => {
    render(<FeatureFlagsScreen />);
    expect(screen.getByText("Limits")).toBeInTheDocument();
    expect(screen.getByText("max_active_trips")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Maximum open (draft/planned/active) trips a user may own.",
      ),
    ).toBeInTheDocument();
    // Per-tier values: free=1, pro/premium unlimited.
    expect(screen.getByText("1 / ∞ / ∞")).toBeInTheDocument();
    // Active global override (launch mode: unlimited) with its reason visible.
    expect(screen.getByText("∞")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Launch mode: unlimited for everyone until tier enforcement goes live.",
      ),
    ).toBeInTheDocument();
  });

  it("does not offer limit creation or deletion", () => {
    render(<FeatureFlagsScreen />);
    expect(
      screen.queryByRole("button", { name: /new limit/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^delete$/i }),
    ).not.toBeInTheDocument();
  });

  it("hides the Clear action and shows a dash when there is no active override", () => {
    mockUseAdminFeatureLimits.mockReturnValue({
      data: {
        limits: [
          {
            ...LIMITS[0],
            global_active: false,
            global_value: null,
            global_reason: null,
          },
        ],
      },
      isPending: false,
      error: null,
      refetch: mockLimitsRefetch,
    });
    render(<FeatureFlagsScreen />);
    expect(
      screen.getByRole("button", { name: "Set override" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Clear override" }),
    ).not.toBeInTheDocument();
  });

  it("set override submits a numeric value with a reason", async () => {
    const user = userEvent.setup();
    render(<FeatureFlagsScreen />);

    await user.click(screen.getByRole("button", { name: "Set override" }));
    const dialog = screen.getByRole("dialog");

    // The row is currently an active unlimited override, so the dialog opens
    // pre-checked; uncheck it to set a concrete numeric value instead.
    const unlimitedCheckbox = within(dialog).getByRole("checkbox", {
      name: /unlimited/i,
    });
    expect(unlimitedCheckbox).toBeChecked();
    await user.click(unlimitedCheckbox);

    // Submitting without a reason blocks the mutation and shows an error.
    await user.click(
      within(dialog).getByRole("button", { name: "Set override" }),
    );
    expect(mockSetLimitGlobal).not.toHaveBeenCalled();
    expect(
      screen.getByText("A reason is required for any global limit change."),
    ).toBeInTheDocument();

    await user.type(
      within(dialog).getByRole("textbox", { name: /value/i }),
      "3",
    );
    await user.type(
      within(dialog).getByRole("textbox", { name: /reason/i }),
      "Promo raise",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Set override" }),
    );

    expect(mockSetLimitGlobal).toHaveBeenCalledWith(
      {
        params: { path: { feature: "max_active_trips" } },
        body: { value: 3, reason: "Promo raise" },
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );

    const [, options] = mockSetLimitGlobal.mock.calls[0] as [
      unknown,
      { onSuccess: () => void },
    ];
    act(() => {
      options.onSuccess();
    });
    expect(mockLimitsRefetch).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("set override blocks a blank value instead of silently defaulting to zero", async () => {
    const user = userEvent.setup();
    render(<FeatureFlagsScreen />);

    await user.click(screen.getByRole("button", { name: "Set override" }));
    const dialog = screen.getByRole("dialog");

    // Uncheck Unlimited but leave the value field blank — `Number("")` is
    // `0`, so this must not silently submit a real 0 (which would block the
    // feature for everyone) without the operator explicitly typing it.
    await user.click(
      within(dialog).getByRole("checkbox", { name: /unlimited/i }),
    );
    await user.type(
      within(dialog).getByRole("textbox", { name: /reason/i }),
      "Oops, forgot the value",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Set override" }),
    );

    expect(mockSetLimitGlobal).not.toHaveBeenCalled();
    expect(
      screen.getByText("Value must be a non-negative integer (or Unlimited)."),
    ).toBeInTheDocument();
  });

  it("set override submits a null value when Unlimited is checked", async () => {
    const user = userEvent.setup();
    render(<FeatureFlagsScreen />);

    await user.click(screen.getByRole("button", { name: "Set override" }));
    const dialog = screen.getByRole("dialog");

    // Already pre-checked (the row is currently an active unlimited override).
    expect(
      within(dialog).getByRole("checkbox", { name: /unlimited/i }),
    ).toBeChecked();

    await user.type(
      within(dialog).getByRole("textbox", { name: /reason/i }),
      "Keep it uncapped",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Set override" }),
    );

    expect(mockSetLimitGlobal).toHaveBeenCalledWith(
      {
        params: { path: { feature: "max_active_trips" } },
        body: { value: null, reason: "Keep it uncapped" },
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("clear fires the clear-global-override mutation and refetches", async () => {
    render(<FeatureFlagsScreen />);
    const clearButtons = screen.getAllByRole("button", {
      name: "Clear override",
    });
    expect(clearButtons).toHaveLength(1);
    await userEvent.click(clearButtons[0]!);

    expect(mockClearLimitGlobal).toHaveBeenCalledWith(
      { params: { path: { feature: "max_active_trips" } } },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );

    const [, options] = mockClearLimitGlobal.mock.calls[0] as [
      unknown,
      { onSuccess: () => void },
    ];
    act(() => {
      options.onSuccess();
    });
    expect(mockLimitsRefetch).toHaveBeenCalled();
  });

  it("surfaces limit mutation errors in an alert", async () => {
    render(<FeatureFlagsScreen />);
    await userEvent.click(
      screen.getAllByRole("button", { name: "Clear override" })[0]!,
    );

    const [, options] = mockClearLimitGlobal.mock.calls[0] as [
      unknown,
      { onError: (err: unknown) => void; onSettled: () => void },
    ];
    act(() => {
      options.onError({ statusCode: 500, message: "Registry unavailable." });
      options.onSettled();
    });
    expect(screen.getByText("Registry unavailable.")).toBeInTheDocument();
  });

  it("shows a limits load error alert", () => {
    mockUseAdminFeatureLimits.mockReturnValue({
      data: undefined,
      isPending: false,
      error: new Error("boom"),
      refetch: mockLimitsRefetch,
    });
    render(<FeatureFlagsScreen />);
    expect(
      screen.getByText("Failed to load feature limits."),
    ).toBeInTheDocument();
  });

  // ── System switches section ───────────────────────────────────────────────────

  it("renders the system switches section with resolved state and disabled reason", () => {
    render(<FeatureFlagsScreen />);
    expect(screen.getByText("System switches")).toBeInTheDocument();
    expect(screen.getByText("sys_weather_provider")).toBeInTheDocument();
    expect(screen.getByText("Weather-along-route data.")).toBeInTheDocument();
    expect(screen.getByText("On")).toBeInTheDocument();
    expect(screen.getByText("sys_nap_routing_avoidance")).toBeInTheDocument();
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    expect(screen.getByText("Valhalla polygon regression")).toBeInTheDocument();
  });

  it("does not offer switch creation or deletion", () => {
    render(<FeatureFlagsScreen />);
    expect(
      screen.queryByRole("button", { name: /new switch/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^delete$/i }),
    ).not.toBeInTheDocument();
  });

  it("disable requires a reason before submitting", async () => {
    const user = userEvent.setup();
    render(<FeatureFlagsScreen />);

    // Only sys_weather_provider (currently on) offers Disable.
    await user.click(screen.getByRole("button", { name: "Disable" }));
    const dialog = screen.getByRole("dialog");

    // Submitting without a reason blocks the mutation and shows an error.
    await user.click(within(dialog).getByRole("button", { name: "Disable" }));
    expect(mockDisableSwitch).not.toHaveBeenCalled();
    expect(
      screen.getByText("A reason is required to disable a system switch."),
    ).toBeInTheDocument();

    // With a reason the kill switch submits.
    await user.type(
      within(dialog).getByRole("textbox", { name: /reason/i }),
      "Provider outage",
    );
    await user.click(within(dialog).getByRole("button", { name: "Disable" }));
    expect(mockDisableSwitch).toHaveBeenCalledWith(
      {
        params: { path: { key: "sys_weather_provider" } },
        body: { reason: "Provider outage" },
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );

    // Success closes the dialog and refetches.
    const [, options] = mockDisableSwitch.mock.calls[0] as [
      unknown,
      { onSuccess: () => void },
    ];
    act(() => {
      options.onSuccess();
    });
    expect(mockSwitchesRefetch).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("disable dialog surfaces a server error without closing", async () => {
    const user = userEvent.setup();
    render(<FeatureFlagsScreen />);

    await user.click(screen.getByRole("button", { name: "Disable" }));
    const dialog = screen.getByRole("dialog");
    await user.type(
      within(dialog).getByRole("textbox", { name: /reason/i }),
      "Provider outage",
    );
    await user.click(within(dialog).getByRole("button", { name: "Disable" }));

    const [, options] = mockDisableSwitch.mock.calls[0] as [
      unknown,
      { onError: (err: unknown) => void },
    ];
    act(() => {
      options.onError({ statusCode: 500, message: "Registry unavailable." });
    });
    expect(screen.getByText("Registry unavailable.")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("enable fires the clear mutation for a disabled switch and refetches", async () => {
    render(<FeatureFlagsScreen />);
    // Only sys_nap_routing_avoidance (currently disabled) offers Enable.
    await userEvent.click(screen.getByRole("button", { name: "Enable" }));

    expect(mockEnableSwitch).toHaveBeenCalledWith(
      { params: { path: { key: "sys_nap_routing_avoidance" } } },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );

    const [, options] = mockEnableSwitch.mock.calls[0] as [
      unknown,
      { onSuccess: () => void },
    ];
    act(() => {
      options.onSuccess();
    });
    expect(mockSwitchesRefetch).toHaveBeenCalled();
  });

  it("surfaces enable mutation errors in an alert", async () => {
    render(<FeatureFlagsScreen />);
    await userEvent.click(screen.getByRole("button", { name: "Enable" }));

    const [, options] = mockEnableSwitch.mock.calls[0] as [
      unknown,
      { onError: (err: unknown) => void; onSettled: () => void },
    ];
    act(() => {
      options.onError({ statusCode: 500, message: "Registry unavailable." });
      options.onSettled();
    });
    expect(screen.getByText("Registry unavailable.")).toBeInTheDocument();
  });

  it("shows a switches load error alert", () => {
    mockUseAdminSystemSwitches.mockReturnValue({
      data: undefined,
      isPending: false,
      error: new Error("boom"),
      refetch: mockSwitchesRefetch,
    });
    render(<FeatureFlagsScreen />);
    expect(
      screen.getByText("Failed to load system switches."),
    ).toBeInTheDocument();
  });
});
