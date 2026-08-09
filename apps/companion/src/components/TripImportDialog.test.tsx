import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TripImportDialog } from "./TripImportDialog";
import { parseImportedRoute } from "@/lib/gpx-kml-import";

// Kill switches fail SAFE (enabled until a confirmed `force_off`).
const killSwitch = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/hooks/useEntitlements", () => ({
  useFeatureKillSwitch: () => ({
    enabled: killSwitch.enabled,
    isResolved: true,
  }),
}));

// STABLE references. `handleFile` is a `useCallback` that closes over these,
// and the effect that starts a parse depends on its identity — hand back a
// fresh object or function per render and the effect re-fires forever.
const translate = (value: string) => value;
const formatter = { distanceKm: (v: number) => `${v} km` };
const tripStoreState = { setActiveTrip: vi.fn() };
vi.mock("@/i18n/I18nProvider", () => ({ useTranslation: () => translate }));
vi.mock("@/format/FormatProvider", () => ({ useFormat: () => formatter }));
vi.mock("@/stores/trip", () => ({
  useTripStore: (selector: (s: unknown) => unknown) => selector(tripStoreState),
  flattenSegments: () => [],
}));
vi.mock("@/lib/gpx-kml-import", () => ({
  parseImportedRoute: vi.fn(() => ({ ok: false, error: "invalid" })),
  importErrorMessage: () => "bad file",
  importedRouteToTrip: vi.fn(),
}));

const parseMock = vi.mocked(parseImportedRoute);

/**
 * A File whose `text()` resolves only when the test says so, which is what
 * makes the mid-read window observable.
 */
function deferredFile() {
  let release!: (value: string) => void;
  const pending = new Promise<string>((resolve) => {
    release = resolve;
  });
  const file = {
    name: "route.gpx",
    text: () => pending,
  } as unknown as File;
  return { file, release };
}

describe("TripImportDialog — gpx_import containment", () => {
  beforeEach(() => {
    parseMock.mockClear();
    killSwitch.enabled = true;
  });

  it("parses a file normally", async () => {
    const { file, release } = deferredFile();
    render(<TripImportDialog open initialFile={file} onClose={vi.fn()} />);
    await act(async () => {
      release("<gpx/>");
    });
    await waitFor(() => expect(parseMock).toHaveBeenCalledTimes(1));
  });

  it("never reaches the parser when the switch is already off", async () => {
    killSwitch.enabled = false;
    const { file, release } = deferredFile();
    render(<TripImportDialog open initialFile={file} onClose={vi.fn()} />);
    // Release the read: without this the assertion below is vacuous — the
    // parser is unreachable simply because the bytes never arrive.
    await act(async () => {
      release("<gpx/>");
    });
    expect(parseMock).not.toHaveBeenCalled();
  });

  it("never reaches the parser when the switch dies DURING the file read", async () => {
    // The window this gate exists for. `gpx_import` is the containment control
    // for a parser vulnerability, so "the dialog is hidden" is not enough — the
    // bytes must not reach `parseImportedRoute` at all. Reading a large file is
    // not instant, and an operator can flip the switch inside that window.
    const { file, release } = deferredFile();
    const view = (open: boolean) => (
      <TripImportDialog open={open} initialFile={file} onClose={vi.fn()} />
    );
    const { rerender } = render(view(true));

    killSwitch.enabled = false;
    // A fresh element: React bails out of a re-render given the identical one.
    rerender(view(true));

    await act(async () => {
      release("<gpx/>");
    });
    expect(parseMock).not.toHaveBeenCalled();
  });

  it("never reaches the parser for a picker opened BEFORE the kill", async () => {
    // A native picker already on screen when the switch dies still fires its
    // `change` event afterwards. `handleFile` takes a FRESH parse token on
    // entry, so every earlier token invalidation is irrelevant to it — only an
    // entry check stops this one.
    killSwitch.enabled = false;
    const { file, release } = deferredFile();
    const { rerender } = render(
      <TripImportDialog open initialFile={null} onClose={vi.fn()} />,
    );

    // The picker's late `change` arrives: the parent hands over the file.
    rerender(<TripImportDialog open initialFile={file} onClose={vi.fn()} />);
    await act(async () => {
      release("<gpx/>");
    });
    expect(parseMock).not.toHaveBeenCalled();
  });
});
