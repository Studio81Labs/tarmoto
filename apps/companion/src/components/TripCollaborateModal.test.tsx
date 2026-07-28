import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TripCollaborateModal } from "@/components/TripCollaborateModal";
import type { Trip } from "@/lib/types";

const minimalTrip: Trip = {
  id: "trip-1",
  name: "Pyrenees Loop",
  status: "planned",
  num_days: 0,
  parameters: {
    days: 1,
    dailyKmTarget: 150,
    roadPreference: "curvy",
    surfacePreference: ["asphalt"],
    avoidHighways: true,
    avoidTolls: false,
    avoidUnpaved: true,
    minQuality: 3,
  },
  collaborators: [],
  days: [],
  createdAt: "2026-04-20T10:00:00.000Z",
  updatedAt: "2026-04-20T10:00:00.000Z",
};

const hoisted = vi.hoisted(() => ({
  create: vi.fn(),
  revoke: vi.fn(),
  listMine: vi.fn(),
}));

vi.mock("@/lib/api", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/api")>();
  return {
    ...actual,
    tripSharesApi: {
      ...actual.tripSharesApi,
      create: hoisted.create,
      revoke: hoisted.revoke,
      listMine: hoisted.listMine,
    },
  };
});

// This file's cases pre-date the `collaborative_trips` gate (US-C2) and
// aren't about entitlements — default to fully entitled/resolved so none of
// them start failing on the new proactive gate. The gate's own behavior
// (not-entitled / unresolved / snapshot-only) is covered in
// `TripCollaborateModal.collaborative-trips.test.tsx`.
const useFeatureMock = vi.fn(() => ({
  enabled: true,
  isLoading: false,
  isError: false,
  isSuccess: true,
}));
const useEntitlementsMock = vi.fn(() => ({ tier: "pro" as string | null }));
vi.mock("@/hooks", () => ({
  useFeature: () => ({ dataUpdatedAt: 0, ...useFeatureMock() }),
  useEntitlements: () => ({
    refetch: vi.fn(),
    dataUpdatedAt: 0,
    ...useEntitlementsMock(),
  }),
}));

// UpgradePrompt calls useRouter() for its CTA — the test tree has no app
// router mounted.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

describe("TripCollaborateModal", () => {
  const originalClipboard = navigator.clipboard;
  const clipboardWrite = vi.fn();

  beforeEach(() => {
    hoisted.create.mockReset();
    hoisted.revoke.mockReset();
    hoisted.listMine
      .mockReset()
      .mockResolvedValue({ data: { items: [], total: 0 } });
    useFeatureMock.mockReset().mockReturnValue({
      enabled: true,
      isLoading: false,
      isError: false,
      isSuccess: true,
    });
    useEntitlementsMock.mockReset().mockReturnValue({ tier: "pro" });
    clipboardWrite.mockReset().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText: clipboardWrite },
    });
  });

  afterEach(() => {
    Object.assign(navigator, { clipboard: originalClipboard });
  });

  it("prompts to load a trip first when none is active", () => {
    render(<TripCollaborateModal open trip={null} onClose={() => {}} />);
    expect(
      screen.getByText(/generate or load a trip first/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: /group link/i }),
    ).not.toBeInTheDocument();
  });

  it("hides invite-link creation when the caller cannot manage trip invites", () => {
    render(
      <TripCollaborateModal
        open
        trip={minimalTrip}
        canCreateInviteLink={false}
        onClose={() => {}}
      />,
    );

    expect(
      screen.getByText(/only trip owners and admins can create invite links/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: /group link/i }),
    ).not.toBeInTheDocument();
    expect(hoisted.create).not.toHaveBeenCalled();
  });

  it("generates a share link and copies it to the clipboard", async () => {
    hoisted.create.mockResolvedValueOnce({
      data: {
        id: "share-1",
        share_token: "a".repeat(32),
        share_url: `/trips/shared/${"a".repeat(32)}`,
        trip_id: null,
        title: "Pyrenees Loop",
        view_count: 0,
        created_at: "2026-04-20T10:00:00.000Z",
        updated_at: "2026-04-20T10:00:00.000Z",
      },
    });

    render(<TripCollaborateModal open trip={minimalTrip} onClose={() => {}} />);

    fireEvent.click(screen.getByRole("switch", { name: /group link/i }));

    await waitFor(() => {
      expect(hoisted.create).toHaveBeenCalledWith({
        title: "Pyrenees Loop",
        snapshot: minimalTrip,
        trip_id: null,
      });
    });

    const input = (await screen.findByLabelText(
      /shareable invite url/i,
    )) as HTMLInputElement;
    expect(input.value).toContain(`/trips/shared/${"a".repeat(32)}`);
    expect(screen.getByRole("switch", { name: /group link/i })).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: /^copy$/i }));

    await waitFor(() => {
      expect(clipboardWrite).toHaveBeenCalledWith(input.value);
    });
    expect(await screen.findByText(/copied/i)).toBeInTheDocument();
  });

  it("rehydrates the group-link toggle from an existing share for a saved trip", async () => {
    hoisted.listMine.mockResolvedValueOnce({
      data: {
        items: [
          {
            id: "share-existing",
            share_token: "c".repeat(32),
            share_url: `/trips/shared/${"c".repeat(32)}`,
            trip_id: "server-trip-1",
            title: "Pyrenees Loop",
            view_count: 3,
            created_at: "2026-04-19T10:00:00.000Z",
            updated_at: "2026-04-19T10:00:00.000Z",
          },
        ],
        total: 1,
      },
    });

    render(
      <TripCollaborateModal
        open
        trip={minimalTrip}
        serverTripId="server-trip-1"
        canCreateInviteLink
        onClose={() => {}}
      />,
    );

    // The toggle reflects the pre-existing share instead of rendering
    // OFF next to a live link (which would mint duplicates on toggle).
    await waitFor(() => {
      expect(screen.getByRole("switch", { name: /group link/i })).toBeChecked();
    });
    expect(
      (screen.getByLabelText(/shareable invite url/i) as HTMLInputElement)
        .value,
    ).toContain(`/trips/shared/${"c".repeat(32)}`);
    expect(hoisted.create).not.toHaveBeenCalled();
  });

  it("revokes the share when the group link is toggled off", async () => {
    hoisted.create.mockResolvedValueOnce({
      data: {
        id: "share-1",
        share_token: "a".repeat(32),
        share_url: `/trips/shared/${"a".repeat(32)}`,
        trip_id: null,
        title: "Pyrenees Loop",
        view_count: 0,
        created_at: "2026-04-20T10:00:00.000Z",
        updated_at: "2026-04-20T10:00:00.000Z",
      },
    });
    hoisted.revoke.mockResolvedValueOnce({ data: undefined });

    render(<TripCollaborateModal open trip={minimalTrip} onClose={() => {}} />);

    fireEvent.click(screen.getByRole("switch", { name: /group link/i }));
    await screen.findByLabelText(/shareable invite url/i);

    fireEvent.click(screen.getByRole("switch", { name: /group link/i }));

    await waitFor(() => {
      expect(hoisted.revoke).toHaveBeenCalledWith("share-1");
    });
    expect(
      screen.queryByLabelText(/shareable invite url/i),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: /group link/i }),
    ).not.toBeChecked();
  });

  it("surfaces an error message when the API call fails", async () => {
    hoisted.create.mockRejectedValueOnce(new Error("Network unavailable"));

    render(<TripCollaborateModal open trip={minimalTrip} onClose={() => {}} />);

    fireEvent.click(screen.getByRole("switch", { name: /group link/i }));

    expect(await screen.findByText("Unknown error")).toBeInTheDocument();
  });

  it("calls onClose when Escape is pressed", () => {
    const handleClose = vi.fn();
    render(
      <TripCollaborateModal open trip={minimalTrip} onClose={handleClose} />,
    );

    fireEvent.keyDown(document, { key: "Escape" });

    expect(handleClose).toHaveBeenCalled();
  });

  it("does not leak a previous session's error when reopened", async () => {
    hoisted.create.mockRejectedValueOnce(new Error("Network unavailable"));

    const { rerender } = render(
      <TripCollaborateModal open trip={minimalTrip} onClose={() => {}} />,
    );

    fireEvent.click(screen.getByRole("switch", { name: /group link/i }));

    expect(await screen.findByText("Unknown error")).toBeInTheDocument();

    // Close, then reopen — the previous session's error must not reappear.
    rerender(
      <TripCollaborateModal
        open={false}
        trip={minimalTrip}
        onClose={() => {}}
      />,
    );
    rerender(
      <TripCollaborateModal open trip={minimalTrip} onClose={() => {}} />,
    );

    expect(screen.queryByText(/network unavailable/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: /group link/i }),
    ).toBeInTheDocument();
  });

  it("keeps the generated share URL when the parent re-renders with a new onClose reference", async () => {
    hoisted.create.mockResolvedValueOnce({
      data: {
        id: "share-1",
        share_token: "a".repeat(32),
        share_url: `/trips/shared/${"a".repeat(32)}`,
        trip_id: null,
        title: "Pyrenees Loop",
        view_count: 0,
        created_at: "2026-04-20T10:00:00.000Z",
        updated_at: "2026-04-20T10:00:00.000Z",
      },
    });

    // Each re-render creates a brand-new inline arrow for onClose, mirroring
    // what `() => setCollaborateOpen(false)` in the planner page does on
    // every parent render.
    const { rerender } = render(
      <TripCollaborateModal open trip={minimalTrip} onClose={() => {}} />,
    );

    fireEvent.click(screen.getByRole("switch", { name: /group link/i }));

    const input = (await screen.findByLabelText(
      /shareable invite url/i,
    )) as HTMLInputElement;
    expect(input.value).toContain(`/trips/shared/${"a".repeat(32)}`);

    // Parent re-renders (e.g. map interaction) — new onClose reference but
    // `open` unchanged. The share URL must stay visible.
    rerender(
      <TripCollaborateModal open trip={minimalTrip} onClose={() => {}} />,
    );
    rerender(
      <TripCollaborateModal open trip={minimalTrip} onClose={() => {}} />,
    );

    expect(
      (screen.getByLabelText(/shareable invite url/i) as HTMLInputElement)
        .value,
    ).toContain(`/trips/shared/${"a".repeat(32)}`);
  });

  it("drops a stale create result when the modal has been closed mid-fetch", async () => {
    let resolveCreate: ((value: unknown) => void) | undefined;
    hoisted.create.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );

    const { rerender } = render(
      <TripCollaborateModal open trip={minimalTrip} onClose={() => {}} />,
    );

    fireEvent.click(screen.getByRole("switch", { name: /group link/i }));

    // Close the modal while the create call is still pending.
    rerender(
      <TripCollaborateModal
        open={false}
        trip={minimalTrip}
        onClose={() => {}}
      />,
    );

    // Now the request resolves — its result should be ignored because the
    // session was closed.
    resolveCreate!({
      data: {
        id: "share-stale",
        share_token: "b".repeat(32),
        share_url: `/trips/shared/${"b".repeat(32)}`,
        trip_id: null,
        title: "Pyrenees Loop",
        view_count: 0,
        created_at: "2026-04-20T10:00:00.000Z",
        updated_at: "2026-04-20T10:00:00.000Z",
      },
    });

    // Reopen — the stale share token must not have leaked into the UI.
    rerender(
      <TripCollaborateModal open trip={minimalTrip} onClose={() => {}} />,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: /group link/i }),
      ).not.toBeChecked();
    });
    expect(
      screen.queryByLabelText(/shareable invite url/i),
    ).not.toBeInTheDocument();
  });
});
