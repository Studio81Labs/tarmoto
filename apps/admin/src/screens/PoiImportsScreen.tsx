import { useRef, useState } from "react";
import type { components } from "@tarmoto/openapi-client";
import {
  Alert,
  Button,
  DataTable,
  type DataTableColumn,
  Mono,
  PageHeader,
  Pill,
  type PillVariant,
} from "@tarmoto/ui";
import type { AdminRole } from "../lib/roleRank.js";
import { canAccess } from "../lib/roleRank.js";
import {
  useAdminPoiRegions,
  useAdminPoiRuns,
  useTriggerPoiImport,
  useUploadPoiExtract,
} from "../data/useAdminPoi.js";
import { TableHeading } from "../components/TableHeading.js";

type RegionStatus = components["schemas"]["RegionImportStatusDto"];
type RunRow = components["schemas"]["RunDto"];
type PoiSource = "osm" | "fsq";

interface GroupedRegion {
  code: string;
  osm?: RegionStatus;
  fsq?: RegionStatus;
}

/**
 * Pivot the flat `(source, code)` rows the backend returns into one row per
 * region `code` with an `osm` slot and an `fsq` slot — the shape the coverage
 * table renders. A `code` can be configured for one source only (e.g. FSQ
 * launched CZ-only while OSM covers 17 countries — see `poi-import.config.ts`),
 * so either slot may be absent; `RegionSourceCell` renders a lightweight
 * placeholder for an absent slot instead of an upload/import surface that
 * would just 400 against an unconfigured `(source, code)` pair.
 *
 * Insertion order (not alphabetical) is kept deliberately: `listRegionStatus`
 * returns rows in registry order (OSM first, then FSQ; within a source, the
 * operator-curated region order from `packages/ingest/src/poi/regions.ts`), which reads as
 * a meaningful rollout priority — alphabetizing would scramble that.
 */
function groupByCode(rows: readonly RegionStatus[]): GroupedRegion[] {
  const byCode = new Map<string, GroupedRegion>();
  for (const row of rows) {
    const entry = byCode.get(row.code) ?? { code: row.code };
    if (row.source === "fsq") entry.fsq = row;
    else entry.osm = row;
    byCode.set(row.code, entry);
  }
  return [...byCode.values()];
}

/** 1024-base (KiB/MiB), mirroring the mobile offline-regions convention. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function importErrorMessage(err: unknown): string {
  const statusCode = (err as { statusCode?: number } | undefined)?.statusCode;
  const serverMsg = (err as { message?: string } | undefined)?.message;
  if (statusCode === 409) {
    return (
      serverMsg ?? "An import for this region is already queued or running."
    );
  }
  if (statusCode === 400) {
    return serverMsg ?? "This region isn't configured for that source.";
  }
  return serverMsg ?? "Failed to trigger the import.";
}

function uploadErrorMessage(err: unknown): string {
  const statusCode = (err as { statusCode?: number } | undefined)?.statusCode;
  const serverMsg = (err as { message?: string } | undefined)?.message;
  if (statusCode === 413) {
    return serverMsg ?? "The file exceeds the upload size limit.";
  }
  if (statusCode === 400) {
    return serverMsg ?? "Invalid extract file for this region/source.";
  }
  return serverMsg ?? "Failed to upload the extract.";
}

/** Maps a `poi_import_runs` row to the compact one-line summary (design spec). */
function lastRunSummary(run: RunRow | null): {
  text: string;
  className: string;
  title?: string;
} {
  if (!run) return { text: "—", className: "text-fg-dim" };
  switch (run.status) {
    case "success":
      // A wipe-guard partial accept (backend #847 review) upserted cleanly
      // but withheld tombstoning (and, for OSM, the coverage stamp) — flag it
      // distinctly from a fully clean success rather than rendering an
      // identical "✓ upserted N" that would hide the caveat.
      return run.warning
        ? {
            text: `⚠ upserted ${run.upserted ?? 0} — ${run.warning}`,
            className: "text-quality-q2",
            title: run.warning,
          }
        : { text: `✓ upserted ${run.upserted ?? 0}`, className: "text-ink" };
    case "skipped":
      return {
        text: `⤼ skipped: ${run.skip_reason ?? "unknown reason"}`,
        className: "text-fg-dim",
      };
    case "failed":
      return {
        text: "✗ failed",
        className: "text-quality-q1",
        ...(run.error ? { title: run.error } : {}),
      };
    default:
      // "running" — the run row itself is in flight (distinct from the
      // BullMQ-probed `live_state` chip shown alongside it).
      return { text: "… running", className: "text-fg-dim" };
  }
}

/**
 * Add/remove one `(source, code)` cell key from an immutable in-flight-keys
 * set (#847 review). `pendingImportKey`/`pendingUploadKey` used to be a
 * single scalar, so two uploads (or two imports) started before either
 * settled would stomp each other's key, and whichever settled FIRST would
 * clear the flag for BOTH cells via its own `onSettled` — wrongly
 * re-enabling Import against a still-in-flight sibling cell's replacement
 * extract. Tracking a `Set` of the same keys the cells already use fixes
 * that: each mutation's start adds its OWN key, its OWN `onSettled` removes
 * only that key, and a cell's pending flag is a `set.has(cellKey)` lookup —
 * concurrent cells never see or clear each other's state.
 */
function withKey(keys: ReadonlySet<string>, key: string): Set<string> {
  return new Set(keys).add(key);
}
function withoutKey(keys: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(keys);
  next.delete(key);
  return next;
}

export function PoiImportsScreen({ currentRole }: { currentRole: AdminRole }) {
  const canMutate = canAccess(currentRole, "admin");
  const { data, isPending, error, refetch } = useAdminPoiRegions();
  const importMutation = useTriggerPoiImport();
  const uploadMutation = useUploadPoiExtract();

  const [pendingImportKeys, setPendingImportKeys] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [pendingUploadKeys, setPendingUploadKeys] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [actionMsg, setActionMsg] = useState<{
    kind: "success" | "danger";
    text: string;
  } | null>(null);

  const rows = groupByCode(data ?? []);

  function handleImport(source: PoiSource, code: string) {
    const key = `${source}:${code}`;
    setPendingImportKeys((prev) => withKey(prev, key));
    setActionMsg(null);
    importMutation.mutate(
      { params: { path: { source, code } } },
      {
        onSuccess: () => {
          setActionMsg({
            kind: "success",
            text: `Import queued for ${code} (${source.toUpperCase()}).`,
          });
          void refetch();
        },
        onError: (err: unknown) =>
          setActionMsg({ kind: "danger", text: importErrorMessage(err) }),
        onSettled: () => setPendingImportKeys((prev) => withoutKey(prev, key)),
      },
    );
  }

  function handleUpload(source: PoiSource, code: string, file: File) {
    const key = `${source}:${code}`;
    setPendingUploadKeys((prev) => withKey(prev, key));
    setActionMsg(null);
    uploadMutation.mutate(
      {
        params: { path: { source, code } },
        // Multipart: the generated schema types the body as `{ file: string }`
        // (OpenAPI's `format: binary` erases to `string`), but we send a real
        // `File`. Route it through a FormData bodySerializer so the browser
        // sets the multipart boundary — mirrors the companion's
        // `roadsApi.uploadReviewPhotos` (see apps/companion/src/lib/api/roads.ts).
        body: { file } as unknown as { file: string },
        bodySerializer(body) {
          const form = new FormData();
          form.append("file", (body as unknown as { file: File }).file);
          return form;
        },
      },
      {
        onSuccess: () => {
          setActionMsg({
            kind: "success",
            text: `Extract uploaded for ${code} (${source.toUpperCase()}).`,
          });
          void refetch();
        },
        onError: (err: unknown) =>
          setActionMsg({ kind: "danger", text: uploadErrorMessage(err) }),
        onSettled: () => setPendingUploadKeys((prev) => withoutKey(prev, key)),
      },
    );
  }

  const columns: ReadonlyArray<DataTableColumn<GroupedRegion>> = [
    {
      key: "code",
      label: "Region",
      primary: true,
      size: "90px",
      render: (row) => (
        <Mono className="text-sm font-bold text-ink">{row.code}</Mono>
      ),
    },
    {
      key: "osm",
      label: "OSM",
      render: (row) => (
        <RegionSourceCell
          source="osm"
          status={row.osm}
          canMutate={canMutate}
          pendingImport={pendingImportKeys.has(`osm:${row.code}`)}
          pendingUpload={pendingUploadKeys.has(`osm:${row.code}`)}
          onImport={() => handleImport("osm", row.code)}
          onUpload={(file) => handleUpload("osm", row.code, file)}
        />
      ),
    },
    {
      key: "fsq",
      label: "FSQ",
      render: (row) => (
        <RegionSourceCell
          source="fsq"
          status={row.fsq}
          canMutate={canMutate}
          pendingImport={pendingImportKeys.has(`fsq:${row.code}`)}
          pendingUpload={pendingUploadKeys.has(`fsq:${row.code}`)}
          onImport={() => handleImport("fsq", row.code)}
          onUpload={(file) => handleUpload("fsq", row.code, file)}
        />
      ),
    },
  ];

  return (
    <section>
      <PageHeader
        title="POI Imports"
        sub="Coverage, extracts, and manual triggers for the OSM and Foursquare bulk POI importers."
      />
      {error ? (
        <Alert
          intent="danger"
          title="Failed to load region status."
          className="mb-4"
        />
      ) : null}
      {actionMsg ? (
        <Alert
          intent={actionMsg.kind}
          title={actionMsg.text}
          className="mb-4"
          compact
        />
      ) : null}
      <DataTable
        columns={columns}
        rows={isPending ? [] : rows}
        rowKey={(row) => row.code}
        showCaret={false}
        header={<TableHeading>Coverage</TableHeading>}
        emptyState={
          <span className="text-sm text-fg-dim">
            {isPending ? "—" : "No configured regions."}
          </span>
        }
        ariaLabel="POI import coverage by region"
      />
      <RunsPanel />
    </section>
  );
}

interface RegionSourceCellProps {
  source: PoiSource;
  status: RegionStatus | undefined;
  canMutate: boolean;
  pendingImport: boolean;
  pendingUpload: boolean;
  onImport: () => void;
  onUpload: (file: File) => void;
}

function RegionSourceCell({
  source,
  status,
  canMutate,
  pendingImport,
  pendingUpload,
  onImport,
  onUpload,
}: RegionSourceCellProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!status) {
    return (
      <span className="text-xs text-fg-dim">
        Not configured for {source.toUpperCase()}
      </span>
    );
  }

  const coverageLabel = status.imported_at
    ? formatDate(status.imported_at)
    : source === "fsq"
      ? "OSM-only"
      : "not covered";
  const extract = status.extract;
  const hasExtract = extract?.present === true;
  const liveVariant: PillVariant =
    status.live_state === "running"
      ? "accent"
      : status.live_state === "queued"
        ? "warning"
        : "ghost";
  const summary = lastRunSummary(status.last_run);
  // `hasExtract` can be stale for one poll cycle during a REPLACEMENT upload:
  // the old extract is still `present: true` right up until the new file's
  // atomic rename lands, so without the pending checks below Import stays
  // clickable and can fire against the outgoing extract. Disabling on this
  // cell's OWN `pendingUpload`/`pendingImport` (not the mutation's global
  // `isPending`, which isn't scoped per row) closes that window; the
  // symmetric `disableUpload` below keeps a mid-import click from starting a
  // second, concurrent upload into the same target path — and ALSO disables
  // Upload whenever `live_state` isn't idle, since a queued/running import
  // can be a CRON dispatch or another admin's manual trigger, neither of
  // which this browser's own `pendingImport` flag ever sees. Replacing the
  // on-disk extract while a worker may be mid-read of it is exactly the race
  // the backend's own `importInFlight` 409 guard defends against
  // server-side (`storeExtract`, #847 review) — this keeps Upload disabled
  // before a click ever reaches that guard.
  const disableImport =
    !hasExtract ||
    status.live_state !== "idle" ||
    pendingUpload ||
    pendingImport;
  const disableUpload = pendingImport || status.live_state !== "idle";

  return (
    <div className="flex flex-col gap-1.5 py-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <Pill variant={status.imported_at ? "accent" : "ghost"}>
          {coverageLabel}
        </Pill>
        <span className="text-xs text-fg-dim">
          {status.poi_count.toLocaleString("en-GB")} POIs
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Pill
          variant={hasExtract ? "ghost" : "neutral"}
          {...(hasExtract && extract
            ? {
                title: `${formatBytes(extract.size_bytes)}, uploaded ${formatDateTime(extract.modified_at)}`,
              }
            : {})}
        >
          {hasExtract && extract
            ? `extract · ${formatDate(extract.modified_at)}`
            : "no extract"}
        </Pill>
        <Pill variant={liveVariant}>{status.live_state}</Pill>
      </div>
      <div
        className={`text-xs ${summary.className}`}
        {...(summary.title ? { title: summary.title } : {})}
      >
        {summary.text}
      </div>
      {canMutate ? (
        <div className="mt-1 flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept={source === "fsq" ? ".fsq.jsonl" : ".osm"}
            className="hidden"
            aria-hidden="true"
            tabIndex={-1}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) onUpload(file);
            }}
          />
          <Button
            variant="secondary"
            size="sm"
            loading={pendingUpload}
            disabled={disableUpload}
            onClick={() => fileInputRef.current?.click()}
          >
            Upload
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={pendingImport}
            disabled={disableImport}
            onClick={onImport}
          >
            Import
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Recent `poi_import_runs` history — self-contained, mirrors `FlagOverridesPanel`
 *  (FeatureFlagsScreen.tsx): its own query, its own card. */
function RunsPanel() {
  const { data, isPending, error } = useAdminPoiRuns({ limit: 50 });
  const rows = data ?? [];

  const columns: ReadonlyArray<DataTableColumn<RunRow>> = [
    {
      key: "started_at",
      label: "Started",
      size: "150px",
      render: (row) => formatDateTime(row.started_at),
    },
    {
      key: "source",
      label: "Source",
      size: "80px",
      render: (row) => (
        <span className="text-sm text-fg-dim">{row.source.toUpperCase()}</span>
      ),
    },
    {
      key: "region_code",
      label: "Region",
      size: "90px",
      primary: true,
    },
    {
      key: "status",
      label: "Status",
      size: "110px",
      render: (row) => (
        <Pill
          variant={
            row.status === "success"
              ? // A wipe-guard partial accept is still `success` (it DID
                // upsert), but the amber "warning" variant flags it as
                // distinct from a fully clean run — mirrors the coverage
                // table's own "⚠ upserted N" cell summary.
                row.warning
                ? "warning"
                : "accent"
              : row.status === "failed"
                ? "danger"
                : row.status === "running"
                  ? "warning"
                  : "ghost"
          }
        >
          {row.status}
        </Pill>
      ),
    },
    {
      key: "trigger",
      label: "Trigger",
      size: "90px",
      render: (row) => <Pill variant="ghost">{row.trigger}</Pill>,
    },
    {
      key: "upserted",
      label: "Upserted",
      size: "100px",
      numeric: true,
      render: (row) => row.upserted ?? "—",
    },
    {
      key: "detail",
      label: "Detail",
      render: (row) =>
        row.status === "failed"
          ? (row.error ?? "—")
          : row.status === "skipped"
            ? (row.skip_reason ?? "—")
            : // A `success` row's only possible detail is the wipe-guard
              // partial-accept advisory — "—" for every clean success, same
              // as before this field existed.
              (row.warning ?? "—"),
    },
  ];

  return (
    <div className="mt-6">
      {error ? (
        <Alert
          intent="danger"
          title="Failed to load run history."
          className="mb-4"
          compact
        />
      ) : null}
      <DataTable
        columns={columns}
        rows={isPending ? [] : rows}
        rowKey={(row) => row.id}
        showCaret={false}
        header={<TableHeading>Recent runs</TableHeading>}
        emptyState={
          <span className="text-sm text-fg-dim">
            {isPending ? "—" : "No runs yet."}
          </span>
        }
        ariaLabel="Recent POI import runs"
      />
    </div>
  );
}
