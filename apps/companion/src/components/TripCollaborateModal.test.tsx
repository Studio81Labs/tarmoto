import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TripCollaborateModal } from "@/components/TripCollaborateModal";
import type { Trip } from "@/lib/types";

const minimalTrip: Trip = {
  id: "trip-1",
  name: "Pyrenees Loop",
  status: "planned",
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

const hoisted = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("@/lib/api", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/api")>();
  return {
    ...actual,
    tripSharesApi: {
      ...actual.tripSharesApi,
      create: hoisted.create,
    },
  };
});

describe("TripCollaborateModal", () => {
  const originalClipboard = navigator.clipboard;
  const clipboardWrite = vi.fn();

  beforeEach(() => {
    hoisted.create.mockReset();
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
      screen.queryByRole("button", { name: /create invite link/i }),
    ).not.toBeInTheDocument();
  });

  it("generates a share link and copies it to the clipboard", async () => {
    hoisted.create.mockResolvedValueOnce({
      data: {
        id: "share-1",
        share_token: "a".repeat(32),
        share_url: `/trips/shared/${"a".repeat(32)}`,
        title: "Pyrenees Loop",
        view_count: 0,
        created_at: "2026-04-20T10:00:00.000Z",
        updated_at: "2026-04-20T10:00:00.000Z",
      },
    });

    render(<TripCollaborateModal open trip={minimalTrip} onClose={() => {}} />);

    fireEvent.click(
      screen.getByRole("button", { name: /create invite link/i }),
    );

    await waitFor(() => {
      expect(hoisted.create).toHaveBeenCalledWith({
        title: "Pyrenees Loop",
        snapshot: minimalTrip,
      });
    });

    const input = (await screen.findByLabelText(
      /shareable invite url/i,
    )) as HTMLInputElement;
    expect(input.value).toContain(`/trips/shared/${"a".repeat(32)}`);

    fireEvent.click(screen.getByRole("button", { name: /^copy$/i }));

    await waitFor(() => {
      expect(clipboardWrite).toHaveBeenCalledWith(input.value);
    });
    expect(await screen.findByText(/copied/i)).toBeInTheDocument();
  });

  it("surfaces an error message when the API call fails", async () => {
    hoisted.create.mockRejectedValueOnce(new Error("Network unavailable"));

    render(<TripCollaborateModal open trip={minimalTrip} onClose={() => {}} />);

    fireEvent.click(
      screen.getByRole("button", { name: /create invite link/i }),
    );

    expect(await screen.findByText(/network unavailable/i)).toBeInTheDocument();
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

    fireEvent.click(
      screen.getByRole("button", { name: /create invite link/i }),
    );

    expect(await screen.findByText(/network unavailable/i)).toBeInTheDocument();

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
      screen.getByRole("button", { name: /create invite link/i }),
    ).toBeInTheDocument();
  });

  it("keeps the generated share URL when the parent re-renders with a new onClose reference", async () => {
    hoisted.create.mockResolvedValueOnce({
      data: {
        id: "share-1",
        share_token: "a".repeat(32),
        share_url: `/trips/shared/${"a".repeat(32)}`,
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

    fireEvent.click(
      screen.getByRole("button", { name: /create invite link/i }),
    );

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

    fireEvent.click(
      screen.getByRole("button", { name: /create invite link/i }),
    );

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
        screen.getByRole("button", { name: /create invite link/i }),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByLabelText(/shareable invite url/i),
    ).not.toBeInTheDocument();
  });
});
