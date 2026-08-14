import { screen, act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFormatters } from "@tarmoto/shared";
import { TripImportDialog, RoutePreview } from "./TripImportDialog";
import { parseImportedRoute } from "@/lib/gpx-kml-import";

// Kill switches fail SAFE (enabled until a confirmed `force_off`).
// KEYED: this dialog reads `gpx_import` AND `road_quality_overlay` (the
// preview's quality readouts). One boolean for both would let a gate on the
// wrong switch pass — the finding on #1204.
const killSwitches = vi.hoisted(
  () =>
    ({ gpx_import: true, road_quality_overlay: true }) as Record<
      string,
      boolean
    >,
);
vi.mock("@/hooks/useEntitlements", () => ({
  useFeatureKillSwitch: (key: string) => ({
    enabled: killSwitches[key] ?? true,
    isResolved: true,
  }),
}));

// STABLE references. `handleFile` is a `useCallback` that closes over these,
// and the effect that starts a parse depends on its identity — hand back a
// fresh object or function per render and the effect re-fires forever.
const translate = (value: string) => value;
// A partial formatter silently drifts from the `Formatters` surface the
// components use — this suite lost two cases to a missing `integer`. Real
// formatters, stable identity (the parse effect depends on it).
const formatter = createFormatters({ locale: "en", units: "metric" });
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
    killSwitches.gpx_import = true;
    killSwitches.road_quality_overlay = true;
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
    killSwitches.gpx_import = false;
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

    killSwitches.gpx_import = false;
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
    killSwitches.gpx_import = false;
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

describe("RoutePreview — road_quality_overlay", () => {
  const route = {
    points: [
      { lat: 1, lng: 2 },
      { lat: 3, lng: 4 },
    ],
    waypoints: [],
    name: "Alps",
  } as never;
  const trip = {
    days: [
      {
        avgQuality: 4.2,
        segments: [{ distanceKm: 10, qualityTier: "good", name: "Ridge" }],
      },
    ],
  } as never;

  function renderPreview() {
    return render(<RoutePreview route={route} trip={trip} segmentCount={1} />);
  }

  beforeEach(() => {
    killSwitches.gpx_import = true;
    killSwitches.road_quality_overlay = true;
  });

  it("shows the quality readouts while the flag is live", () => {
    renderPreview();
    expect(screen.getByText("Avg quality")).toBeInTheDocument();
    expect(screen.getByText(/Segment quality/)).toBeInTheDocument();
  });

  it("hides the stat, the note and the segment list under the kill", () => {
    killSwitches.road_quality_overlay = false;
    renderPreview();

    expect(screen.queryByText("Avg quality")).not.toBeInTheDocument();
    expect(screen.queryByText(/Segment quality/)).not.toBeInTheDocument();
    // The note explains the list, so it goes with it rather than describing
    // something no longer on screen.
    expect(screen.queryByText(/deterministic preview/)).not.toBeInTheDocument();
    // The rest of the preview — the import itself is a DIFFERENT switch.
    expect(screen.getByText("Points")).toBeInTheDocument();
  });

  it("drops the readouts on a LIVE flip with the preview already open", () => {
    // Mounting already-killed cannot catch an implementation that snapshots
    // the flag at mount: the switch is polled, so a rider looking at a preview
    // when the operator flips it must lose the quality readouts without a
    // remount. The plan asks for this case specifically.
    const { rerender } = renderPreview();
    expect(screen.getByText("Avg quality")).toBeInTheDocument();

    killSwitches.road_quality_overlay = false;
    rerender(<RoutePreview route={route} trip={trip} segmentCount={1} />);

    expect(screen.queryByText("Avg quality")).not.toBeInTheDocument();
    expect(screen.queryByText(/Segment quality/)).not.toBeInTheDocument();
    expect(screen.queryByText(/deterministic preview/)).not.toBeInTheDocument();
    // The non-quality preview survives the flip.
    expect(screen.getByText("Points")).toBeInTheDocument();
  });
});
