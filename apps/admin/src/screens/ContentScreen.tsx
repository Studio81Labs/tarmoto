import { useState } from "react";
import type { components } from "@tarmoto/openapi-client";
import {
  Alert,
  Button,
  DataTable,
  type DataTableColumn,
  Input,
  PageHeader,
  Pill,
  Select,
} from "@tarmoto/ui";
import type { AdminRole } from "../lib/roleRank.js";
import { canAccess } from "../lib/roleRank.js";
import {
  type ContentStatusParam,
  type ContentTypeParam,
  useAdminContentList,
  useDeleteContent,
  useHideContent,
  useRestoreContent,
} from "../data/useAdminContent.js";

type ContentItem = components["schemas"]["ContentItemDto"];

const PAGE_SIZE = 25;

const TYPE_TABS: ReadonlyArray<{ key: ContentTypeParam; label: string }> = [
  { key: "hazard", label: "Hazards" },
  { key: "review", label: "Reviews" },
  { key: "trip_message", label: "Messages" },
];

function readErrorMessage(err: unknown, fallback: string): string {
  const statusCode = (err as { statusCode?: number } | undefined)?.statusCode;
  const serverMsg = (err as { message?: string } | undefined)?.message;
  if (statusCode === 404)
    return serverMsg ?? "Content not found (it may have been deleted).";
  if (statusCode === 403) return serverMsg ?? "Permission denied.";
  return serverMsg ?? fallback;
}

export function ContentScreen({ currentRole }: { currentRole: AdminRole }) {
  const [type, setType] = useState<ContentTypeParam>("hazard");
  const [status, setStatus] = useState<ContentStatusParam>("all");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, isPending, error, refetch } = useAdminContentList({
    type,
    status,
    q: q || undefined,
    page,
    pageSize: PAGE_SIZE,
  });
  const hideMutation = useHideContent();
  const restoreMutation = useRestoreContent();
  const deleteMutation = useDeleteContent();

  const canDelete = canAccess(currentRole, "admin");
  const rows: ContentItem[] = data?.rows ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function runMutation(mutate: () => void, id: string) {
    setPendingId(id);
    setActionError(null);
    mutate();
  }

  const columns: ReadonlyArray<DataTableColumn<ContentItem>> = [
    {
      key: "author",
      label: "Author",
      primary: true,
      render: (row) =>
        row.authorId ? (
          <a className="text-link hover:underline" href={`#/users`}>
            {row.authorName ?? row.authorId}
          </a>
        ) : (
          "—"
        ),
    },
    {
      key: "text",
      label: "Text",
      render: (row) => row.text ?? "—",
    },
    {
      key: "photos",
      label: "Photos",
      size: "80px",
      render: (row) =>
        row.photoUrls.length ? String(row.photoUrls.length) : "—",
    },
    {
      key: "status",
      label: "Status",
      size: "110px",
      render: (row) => (
        <Pill variant={row.status === "hidden" ? "danger" : "ghost"}>
          {row.status}
        </Pill>
      ),
    },
    {
      key: "reason",
      label: "Reason",
      render: (row) => row.moderationReason ?? "—",
    },
    {
      key: "actions",
      label: "",
      size: "240px",
      align: "right",
      render: (row) => (
        <div className="flex items-center justify-end gap-2">
          {row.status === "hidden" ? (
            <Button
              variant="secondary"
              size="sm"
              loading={pendingId === row.id}
              onClick={() =>
                runMutation(
                  () =>
                    restoreMutation.mutate(
                      { params: { path: { type, id: row.id } } },
                      {
                        onSuccess: () => void refetch(),
                        onError: (err: unknown) =>
                          setActionError(
                            readErrorMessage(err, "Failed to restore."),
                          ),
                        onSettled: () => setPendingId(null),
                      },
                    ),
                  row.id,
                )
              }
            >
              Restore
            </Button>
          ) : (
            <Button
              variant="danger"
              size="sm"
              loading={pendingId === row.id}
              onClick={() => {
                const reason =
                  window.prompt("Reason for hiding (optional):") ?? "";
                runMutation(
                  () =>
                    hideMutation.mutate(
                      {
                        params: { path: { type, id: row.id } },
                        body: { reason: reason || null },
                      },
                      {
                        onSuccess: () => void refetch(),
                        onError: (err: unknown) =>
                          setActionError(
                            readErrorMessage(err, "Failed to hide."),
                          ),
                        onSettled: () => setPendingId(null),
                      },
                    ),
                  row.id,
                );
              }}
            >
              Hide
            </Button>
          )}
          {canDelete ? (
            <Button
              variant="danger"
              size="sm"
              loading={pendingId === row.id}
              onClick={() => {
                if (!window.confirm("Permanently delete this content?")) return;
                runMutation(
                  () =>
                    deleteMutation.mutate(
                      { params: { path: { type, id: row.id } } },
                      {
                        onSuccess: () => void refetch(),
                        onError: (err: unknown) =>
                          setActionError(
                            readErrorMessage(err, "Failed to delete."),
                          ),
                        onSettled: () => setPendingId(null),
                      },
                    ),
                  row.id,
                );
              }}
            >
              Delete
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <section>
      <PageHeader title="Content Moderation" />
      {error ? (
        <Alert
          intent="danger"
          title="Failed to load content."
          className="mb-4"
        />
      ) : null}

      <div className="mb-4 flex gap-2">
        {TYPE_TABS.map((tab) => (
          <Button
            key={tab.key}
            variant={type === tab.key ? "primary" : "secondary"}
            size="sm"
            onClick={() => {
              setType(tab.key);
              setPage(1);
            }}
          >
            {tab.label}
          </Button>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Input
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(1);
          }}
          placeholder="Search text"
          ariaLabel="Search content text"
          type="search"
        />
        <Select
          value={status}
          onChange={(v) => {
            if (v === "all" || v === "visible" || v === "hidden") {
              setStatus(v);
              setPage(1);
            }
          }}
          ariaLabel="Status filter"
        >
          <option value="all">All</option>
          <option value="visible">Visible</option>
          <option value="hidden">Hidden</option>
        </Select>
      </div>

      {actionError ? (
        <Alert intent="danger" title={actionError} className="mb-4" compact />
      ) : null}

      <DataTable
        columns={columns}
        rows={isPending ? [] : rows}
        rowKey={(row) => row.id}
        showCaret={false}
        emptyState={
          <span className="text-sm text-fg-dim">
            {isPending ? "—" : "No content found."}
          </span>
        }
        ariaLabel="Content moderation"
      />

      <div className="mt-4 flex items-center gap-3 text-sm text-fg-dim">
        <span>
          Page {page} of {totalPages} ({total} total)
        </span>
        <Button
          variant="secondary"
          size="sm"
          disabled={page <= 1}
          onClick={() => setPage((p) => Math.max(1, p - 1))}
        >
          Prev
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => setPage((p) => p + 1)}
        >
          Next
        </Button>
      </div>
    </section>
  );
}
