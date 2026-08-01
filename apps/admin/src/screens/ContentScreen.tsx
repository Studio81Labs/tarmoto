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
  Textarea,
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
import { Dialog } from "../components/Dialog.js";
import { Pagination } from "../components/Pagination.js";

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
  // Default to "visible" so the initial load is index-served (the backend
  // only indexes (moderation_status, created_at)); "all"/"hidden" are
  // explicit picks.
  const [status, setStatus] = useState<ContentStatusParam>("visible");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Hide/delete now run through confirm dialogs rather than window.prompt/confirm.
  const [hideTarget, setHideTarget] = useState<ContentItem | null>(null);
  const [hideReason, setHideReason] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ContentItem | null>(null);

  const { data, isPending, error, refetch } = useAdminContentList({
    type,
    status,
    ...(q ? { q } : {}),
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

  function confirmHide() {
    if (!hideTarget) return;
    const id = hideTarget.id;
    const reason = hideReason.trim();
    setPendingId(id);
    setActionError(null);
    hideMutation.mutate(
      { params: { path: { type, id } }, body: { reason: reason || null } },
      {
        onSuccess: () => {
          setHideTarget(null);
          setHideReason("");
          void refetch();
        },
        onError: (err: unknown) =>
          setActionError(readErrorMessage(err, "Failed to hide.")),
        onSettled: () => setPendingId(null),
      },
    );
  }

  function confirmDelete() {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    setPendingId(id);
    setActionError(null);
    deleteMutation.mutate(
      { params: { path: { type, id } } },
      {
        onSuccess: () => {
          setDeleteTarget(null);
          void refetch();
        },
        onError: (err: unknown) =>
          setActionError(readErrorMessage(err, "Failed to delete.")),
        onSettled: () => setPendingId(null),
      },
    );
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
      size: "160px",
      render: (row) =>
        row.photoUrls.length ? (
          <div className="flex flex-wrap items-center gap-1">
            {row.photoUrls.map((url, i) => (
              <a
                key={url}
                href={url}
                target="_blank"
                rel="noreferrer"
                title={`Open photo ${i + 1}`}
              >
                <img
                  src={url}
                  alt={`Attachment ${i + 1}`}
                  className="h-9 w-9 rounded border border-line object-cover"
                />
              </a>
            ))}
          </div>
        ) : (
          "—"
        ),
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
                setHideReason("");
                setActionError(null);
                setHideTarget(row);
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
                setActionError(null);
                setDeleteTarget(row);
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

      <div className="mb-4 flex items-end gap-3">
        <div className="w-64">
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
        </div>
        <div className="w-40">
          <Select
            value={status}
            onChange={(v) => {
              if (v === "all" || v === "visible" || v === "hidden") {
                setStatus(v);
                setPage(1);
              }
            }}
            options={[
              { value: "all", label: "All" },
              { value: "visible", label: "Visible" },
              { value: "hidden", label: "Hidden" },
            ]}
            ariaLabel="Status filter"
          />
        </div>
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
        footer={
          <Pagination
            page={page}
            pageCount={totalPages}
            total={total}
            onPageChange={setPage}
          />
        }
      />

      <Dialog
        open={hideTarget !== null}
        title="Hide content"
        onClose={() => setHideTarget(null)}
        busy={hideMutation.isPending}
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setHideTarget(null)}
            >
              Cancel
            </Button>
            <Button
              variant="danger-solid"
              size="sm"
              loading={hideMutation.isPending}
              onClick={confirmHide}
            >
              Hide
            </Button>
          </>
        }
      >
        {actionError ? (
          <Alert intent="danger" title={actionError} className="mb-4" compact />
        ) : null}
        <p className="mb-3 text-[13px] leading-relaxed text-fg-dim">
          This pulls the item from public surfaces immediately. You can restore
          it later. An optional reason is recorded in the audit log.
        </p>
        <Textarea
          value={hideReason}
          onChange={setHideReason}
          rows={3}
          placeholder="Reason (optional) — e.g. spam, abusive language"
          ariaLabel="Reason for hiding"
        />
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        title="Delete content"
        onClose={() => setDeleteTarget(null)}
        busy={deleteMutation.isPending}
        size="sm"
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setDeleteTarget(null)}
            >
              Cancel
            </Button>
            <Button
              variant="danger-solid"
              size="sm"
              loading={deleteMutation.isPending}
              onClick={confirmDelete}
            >
              Delete permanently
            </Button>
          </>
        }
      >
        {actionError ? (
          <Alert intent="danger" title={actionError} className="mb-4" compact />
        ) : null}
        <p className="text-[13px] leading-relaxed text-fg-dim">
          This permanently deletes the item and its attachments. This cannot be
          undone.
        </p>
      </Dialog>
    </section>
  );
}
