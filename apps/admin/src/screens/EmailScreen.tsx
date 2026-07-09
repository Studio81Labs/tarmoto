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
import { useAdminEmailLog } from "../data/useAdminEmail.js";

type EmailRow = components["schemas"]["AdminEmailLogRowDto"];
type StatusFilter = "" | "sent" | "failed";

const PAGE_SIZE = 25;

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function EmailScreen() {
  const [status, setStatus] = useState<StatusFilter>("");
  const [tag, setTag] = useState("");
  const [recipient, setRecipient] = useState("");
  const [page, setPage] = useState(1);

  const { data, isPending, error } = useAdminEmailLog({
    ...(status ? { status } : {}),
    ...(tag ? { tag } : {}),
    ...(recipient ? { recipient } : {}),
    page,
    pageSize: PAGE_SIZE,
  });

  const rows: EmailRow[] = data?.rows ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const columns: ReadonlyArray<DataTableColumn<EmailRow>> = [
    { key: "recipient", label: "Recipient", primary: true },
    {
      key: "tag",
      label: "Type",
      size: "160px",
      render: (row) => <Pill variant="ghost">{row.tag}</Pill>,
    },
    { key: "subject", label: "Subject" },
    {
      key: "status",
      label: "Status",
      size: "160px",
      render: (row) => (
        <div className="flex flex-col gap-0.5">
          <Pill variant={row.status === "sent" ? "accent" : "danger"}>
            {row.status}
          </Pill>
          {row.status === "failed" && row.error_class ? (
            <span className="text-xs text-fg-dim">{row.error_class}</span>
          ) : null}
        </div>
      ),
    },
    {
      key: "provider",
      label: "Provider",
      size: "110px",
      render: (row) => (
        <span className="text-sm text-fg-dim">{row.provider ?? "—"}</span>
      ),
    },
    {
      key: "created_at",
      label: "Sent",
      size: "180px",
      render: (row) => formatDateTime(row.created_at),
    },
  ];

  return (
    <section>
      <PageHeader title="Email Log" />
      {error ? (
        <Alert
          intent="danger"
          title="Failed to load the email log."
          className="mb-4"
        />
      ) : null}
      <div className="mb-4 flex flex-wrap gap-3">
        <Select
          value={status}
          onChange={(v) => {
            if (v === "" || v === "sent" || v === "failed") {
              setStatus(v);
              setPage(1);
            }
          }}
          ariaLabel="Filter by status"
          className="w-36"
        >
          <option value="">All statuses</option>
          <option value="sent">Sent</option>
          <option value="failed">Failed</option>
        </Select>
        <Input
          value={tag}
          onChange={(v) => {
            setTag(v);
            setPage(1);
          }}
          type="search"
          placeholder="Filter by type (e.g. weekly-digest)…"
          ariaLabel="Filter by template tag"
          className="max-w-xs"
        />
        <Input
          value={recipient}
          onChange={(v) => {
            setRecipient(v);
            setPage(1);
          }}
          type="search"
          placeholder="Recipient email (exact)…"
          ariaLabel="Filter by recipient email"
          className="max-w-xs"
        />
      </div>
      <DataTable
        columns={columns}
        rows={isPending ? [] : rows}
        rowKey={(row) => row.id}
        showCaret={false}
        emptyState={
          <span className="text-sm text-fg-dim">
            {isPending ? "—" : "No emails found."}
          </span>
        }
        ariaLabel="Email delivery log"
      />
      <div className="mt-3 flex items-center justify-between text-sm text-fg-dim">
        <span>
          Page {page} of {totalPages} ({total} total)
        </span>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
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
      </div>
    </section>
  );
}
