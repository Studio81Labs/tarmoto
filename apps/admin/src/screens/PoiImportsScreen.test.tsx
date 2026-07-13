import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { components } from "@tarmoto/openapi-client";
import { PoiImportsScreen } from "./PoiImportsScreen.js";

type RegionStatus = components["schemas"]["RegionImportStatusDto"];
type RunRow = components["schemas"]["RunDto"];

const mockTriggerImport = vi.fn();
const mockUploadExtract = vi.fn();
const mockRefetchRegions = vi.fn();
const mockUseAdminPoiRegions = vi.fn();
const mockUseAdminPoiRuns = vi.fn();

vi.mock("../data/useAdminPoi.js", () => ({
  useAdminPoiRegions: () => mockUseAdminPoiRegions(),
  useAdminPoiRuns: (params: unknown) => mockUseAdminPoiRuns(params),
  useTriggerPoiImport: () => ({ mutate: mockTriggerImport, isPending: false }),
  useUploadPoiExtract: () => ({ mutate: mockUploadExtract, isPending: false }),
}));

// CZ: configured for both sources — OSM imported + has an extract (Import
// enabled); FSQ has no coverage stamp and no extract (Import disabled).
// SK: configured for OSM only (never imported, queued, failed last run) —
// the FSQ cell must render the "not configured" placeholder, not a live cell.
const REGIONS: RegionStatus[] = [
  {
    source: "osm",
    code: "CZ",
    configured: true,
    imported_at: "2026-06-01T00:00:00Z",
    poi_count: 12345,
    extract: {
      present: true,
      size_bytes: 52_428_800,
      modified_at: "2026-06-30T10:00:00Z",
    },
    last_run: {
      id: "r1",
      source: "osm",
      region_code: "CZ",
      status: "success",
      trigger: "cron",
      fetched: 100,
      upserted: 90,
      tombstoned: 2,
      skip_reason: null,
      error: null,
      started_at: "2026-06-30T09:55:00Z",
      finished_at: "2026-06-30T10:00:00Z",
    },
    live_state: "idle",
  },
  {
    source: "fsq",
    code: "CZ",
    configured: true,
    imported_at: null,
    poi_count: 300,
    extract: null,
    last_run: null,
    live_state: "idle",
  },
  {
    source: "osm",
    code: "SK",
    configured: true,
    imported_at: null,
    poi_count: 0,
    extract: null,
    last_run: {
      id: "r2",
      source: "osm",
      region_code: "SK",
      status: "failed",
      trigger: "manual",
      fetched: null,
      upserted: null,
      tombstoned: null,
      skip_reason: null,
      error: "boom",
      started_at: "2026-06-29T00:00:00Z",
      finished_at: "2026-06-29T00:01:00Z",
    },
    live_state: "queued",
  },
];

const RUNS: RunRow[] = [
  {
    id: "r1",
    source: "osm",
    region_code: "CZ",
    status: "success",
    trigger: "cron",
    fetched: 100,
    upserted: 90,
    tombstoned: 2,
    skip_reason: null,
    error: null,
    started_at: "2026-06-30T09:55:00Z",
    finished_at: "2026-06-30T10:00:00Z",
  },
  {
    id: "r2",
    source: "osm",
    region_code: "SK",
    status: "failed",
    trigger: "manual",
    fetched: null,
    upserted: null,
    tombstoned: null,
    skip_reason: null,
    error: "boom",
    started_at: "2026-06-29T00:00:00Z",
    finished_at: "2026-06-29T00:01:00Z",
  },
];

function defaultRegionsReturn() {
  return {
    data: REGIONS,
    isPending: false,
    error: null,
    refetch: mockRefetchRegions,
  };
}

function defaultRunsReturn() {
  return { data: RUNS, isPending: false, error: null };
}

/**
 * Finds the coverage table's `<tr>` for a region code (via its Mono cell).
 * Scoped to the coverage table specifically — the Runs panel below also
 * renders bare region codes (`region_code`), so an unscoped `getByText`
 * would match both.
 */
function regionRow(code: string): HTMLElement {
  const table = screen.getByRole("table", {
    name: "POI import coverage by region",
  });
  const row = within(table).getByText(code).closest("tr");
  if (!row) throw new Error(`row not found for region ${code}`);
  return row;
}

describe("PoiImportsScreen", () => {
  beforeEach(() => {
    mockTriggerImport.mockClear();
    mockUploadExtract.mockClear();
    mockRefetchRegions.mockClear();
    mockUseAdminPoiRegions.mockClear();
    mockUseAdminPoiRuns.mockClear();
    mockUseAdminPoiRegions.mockReturnValue(defaultRegionsReturn());
    mockUseAdminPoiRuns.mockReturnValue(defaultRunsReturn());
  });

  it("shows the loading placeholder while regions are pending", () => {
    mockUseAdminPoiRegions.mockReturnValue({
      data: undefined,
      isPending: true,
      error: null,
      refetch: mockRefetchRegions,
    });
    render(<PoiImportsScreen currentRole="admin" />);
    // Scoped to the coverage table: the Runs panel below is an independent
    // mock (still "loaded") and legitimately renders its own "CZ"/"—" text.
    const table = screen.getByRole("table", {
      name: "POI import coverage by region",
    });
    expect(within(table).getByText("—")).toBeInTheDocument();
    expect(within(table).queryByText("CZ")).not.toBeInTheDocument();
  });

  it("groups flat (source, code) rows into one row per region with per-source cells", () => {
    render(<PoiImportsScreen currentRole="admin" />);
    const cz = within(regionRow("CZ"));
    const expectedImportDate = new Date(
      "2026-06-01T00:00:00Z",
    ).toLocaleDateString("en-GB", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    expect(cz.getByText(expectedImportDate)).toBeInTheDocument();
    expect(cz.getByText("OSM-only")).toBeInTheDocument();
    expect(cz.getByText("12,345 POIs")).toBeInTheDocument();
    expect(cz.getByText("300 POIs")).toBeInTheDocument();
    expect(cz.getByText("✓ upserted 90")).toBeInTheDocument();
    expect(cz.getAllByText("idle")).toHaveLength(2);

    const sk = within(regionRow("SK"));
    expect(sk.getByText("not covered")).toBeInTheDocument();
    expect(sk.getByText("Not configured for FSQ")).toBeInTheDocument();
    expect(sk.getByText("queued")).toBeInTheDocument();
    expect(sk.getByText("✗ failed")).toBeInTheDocument();
  });

  it("shows the extract chip when present and 'no extract' otherwise", () => {
    render(<PoiImportsScreen currentRole="admin" />);
    const cz = within(regionRow("CZ"));
    const expectedExtractDate = new Date(
      "2026-06-30T10:00:00Z",
    ).toLocaleDateString("en-GB", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    expect(
      cz.getByText(`extract · ${expectedExtractDate}`),
    ).toBeInTheDocument();
    expect(cz.getByText("no extract")).toBeInTheDocument();
  });

  it("disables Import when live_state isn't idle, or when no extract is present", () => {
    render(<PoiImportsScreen currentRole="admin" />);
    const cz = within(regionRow("CZ"));
    const czImportButtons = cz.getAllByRole("button", { name: "Import" });
    // OSM: idle + extract present → enabled.
    expect(czImportButtons[0]).toBeEnabled();
    // FSQ: idle but no extract → disabled.
    expect(czImportButtons[1]).toBeDisabled();

    const sk = within(regionRow("SK"));
    // OSM: queued (and no extract) → disabled.
    expect(sk.getByRole("button", { name: "Import" })).toBeDisabled();
    // No FSQ row for SK at all → no Import/Upload controls in that cell.
    expect(sk.getAllByRole("button", { name: "Import" })).toHaveLength(1);
  });

  it("disables Import for a cell while that SAME cell's upload is pending (replacement-upload race, #847 review)", () => {
    render(<PoiImportsScreen currentRole="admin" />);
    const cz = within(regionRow("CZ"));
    // OSM: idle + extract present → enabled before any upload starts.
    expect(cz.getAllByRole("button", { name: "Import" })[0]).toBeEnabled();

    // Locate the OSM file input directly (mirrors the upload test below).
    const inputs =
      regionRow("CZ").querySelectorAll<HTMLInputElement>('input[type="file"]');
    const file = new File(["osm extract"], "cz.osm", {
      type: "application/octet-stream",
    });
    fireEvent.change(inputs[0]!, { target: { files: [file] } });

    // handleUpload never settles in this test (the mocked mutate() doesn't
    // invoke onSettled), so `pendingUpload` stays true for osm:CZ — exactly
    // the window between a replacement upload starting and its atomic
    // rename landing. Import for the SAME cell must be disabled throughout.
    expect(cz.getAllByRole("button", { name: "Import" })[0]).toBeDisabled();
  });

  it("disables Upload for a cell while that SAME cell's import is pending (symmetric fix)", async () => {
    const user = userEvent.setup();
    render(<PoiImportsScreen currentRole="admin" />);
    const cz = within(regionRow("CZ"));
    // OSM: idle + extract present → both controls enabled before any click.
    expect(cz.getAllByRole("button", { name: "Upload" })[0]).toBeEnabled();

    await user.click(cz.getAllByRole("button", { name: "Import" })[0]!);

    // handleImport never settles in this test (the mocked mutate() doesn't
    // invoke onSettled), so `pendingImport` stays true for osm:CZ — Upload
    // for the SAME cell must be disabled while that import is in flight.
    expect(cz.getAllByRole("button", { name: "Upload" })[0]).toBeDisabled();
  });

  it("hides Upload/Import controls for a support-role admin", () => {
    render(<PoiImportsScreen currentRole="support" />);
    expect(regionRow("CZ")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Upload" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Import" }),
    ).not.toBeInTheDocument();
  });

  it("triggers an import for the right (source, code), shows a success message, and refetches", async () => {
    const user = userEvent.setup();
    render(<PoiImportsScreen currentRole="admin" />);
    const cz = within(regionRow("CZ"));
    await user.click(cz.getAllByRole("button", { name: "Import" })[0]!);

    expect(mockTriggerImport).toHaveBeenCalledWith(
      { params: { path: { source: "osm", code: "CZ" } } },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
        onSettled: expect.any(Function),
      }),
    );

    const [, options] = mockTriggerImport.mock.calls[0] as [
      unknown,
      { onSuccess: () => void },
    ];
    act(() => {
      options.onSuccess();
    });
    expect(screen.getByText("Import queued for CZ (OSM).")).toBeInTheDocument();
    expect(mockRefetchRegions).toHaveBeenCalled();
  });

  it("shows the server's message on a 409 (already in flight)", async () => {
    const user = userEvent.setup();
    render(<PoiImportsScreen currentRole="admin" />);
    const cz = within(regionRow("CZ"));
    await user.click(cz.getAllByRole("button", { name: "Import" })[0]!);

    const [, options] = mockTriggerImport.mock.calls[0] as [
      unknown,
      { onError: (err: unknown) => void },
    ];
    act(() => {
      options.onError({
        statusCode: 409,
        message: "import for osm/CZ already in flight",
      });
    });
    expect(
      screen.getByText("import for osm/CZ already in flight"),
    ).toBeInTheDocument();
  });

  it("falls back to a generic message on a 409 with no server message", async () => {
    const user = userEvent.setup();
    render(<PoiImportsScreen currentRole="admin" />);
    const cz = within(regionRow("CZ"));
    await user.click(cz.getAllByRole("button", { name: "Import" })[0]!);

    const [, options] = mockTriggerImport.mock.calls[0] as [
      unknown,
      { onError: (err: unknown) => void },
    ];
    act(() => {
      options.onError({ statusCode: 409 });
    });
    expect(
      screen.getByText(
        "An import for this region is already queued or running.",
      ),
    ).toBeInTheDocument();
  });

  it("uploads the selected file to the right (source, code) as multipart form data", () => {
    render(<PoiImportsScreen currentRole="admin" />);
    const row = regionRow("CZ");
    const inputs = row.querySelectorAll<HTMLInputElement>('input[type="file"]');
    expect(inputs).toHaveLength(2);
    const [osmInput, fsqInput] = inputs;
    expect(osmInput!.accept).toBe(".osm");
    expect(fsqInput!.accept).toBe(".fsq.jsonl");

    const file = new File(["osm extract"], "cz.osm", {
      type: "application/octet-stream",
    });
    fireEvent.change(osmInput!, { target: { files: [file] } });

    expect(mockUploadExtract).toHaveBeenCalledTimes(1);
    const [variables, options] = mockUploadExtract.mock.calls[0] as [
      {
        params: { path: { source: string; code: string } };
        body: unknown;
        bodySerializer: (body: unknown) => FormData;
      },
      { onSuccess: () => void },
    ];
    expect(variables.params).toEqual({ path: { source: "osm", code: "CZ" } });

    // The multipart wiring is the crux of this endpoint — exercise the
    // bodySerializer exactly as the real mutation call would.
    const form = variables.bodySerializer(variables.body);
    expect(form.get("file")).toBe(file);

    act(() => {
      options.onSuccess();
    });
    expect(
      screen.getByText("Extract uploaded for CZ (OSM)."),
    ).toBeInTheDocument();
    expect(mockRefetchRegions).toHaveBeenCalled();
  });

  it("shows a friendly message when an upload is rejected as too large (413)", () => {
    render(<PoiImportsScreen currentRole="admin" />);
    const row = regionRow("CZ");
    const [osmInput] =
      row.querySelectorAll<HTMLInputElement>('input[type="file"]');
    fireEvent.change(osmInput!, {
      target: { files: [new File(["x"], "cz.osm")] },
    });

    const [, options] = mockUploadExtract.mock.calls[0] as [
      unknown,
      { onError: (err: unknown) => void },
    ];
    act(() => {
      options.onError({
        statusCode: 413,
        message: "extract exceeds 209715200 bytes",
      });
    });
    expect(
      screen.getByText("extract exceeds 209715200 bytes"),
    ).toBeInTheDocument();
  });

  it("shows a load error alert when region status fails to load", () => {
    mockUseAdminPoiRegions.mockReturnValue({
      data: undefined,
      isPending: false,
      error: new Error("boom"),
      refetch: mockRefetchRegions,
    });
    render(<PoiImportsScreen currentRole="admin" />);
    expect(
      screen.getByText("Failed to load region status."),
    ).toBeInTheDocument();
  });

  it("renders the recent runs panel, scoped separately from the coverage table", () => {
    render(<PoiImportsScreen currentRole="admin" />);
    const panel = screen.getByText("Recent runs").closest("div");
    if (!panel) throw new Error("runs panel not found");
    expect(within(panel).getByText("success")).toBeInTheDocument();
    expect(within(panel).getByText("failed")).toBeInTheDocument();
    expect(within(panel).getByText("boom")).toBeInTheDocument();
  });

  it("shows a load error alert when run history fails to load", () => {
    mockUseAdminPoiRuns.mockReturnValue({
      data: undefined,
      isPending: false,
      error: new Error("boom"),
    });
    render(<PoiImportsScreen currentRole="admin" />);
    expect(screen.getByText("Failed to load run history.")).toBeInTheDocument();
  });
});
