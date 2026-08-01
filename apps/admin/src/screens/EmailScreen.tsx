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
import {
  useAdminEmailLog,
  useSendTestDigest,
  useResendDigest,
} from "../data/useAdminEmail.js";
import { Pagination } from "../components/Pagination.js";

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

  const { data, isPending, error, refetch } = useAdminEmailLog({
    ...(status ? { status } : {}),
    ...(tag ? { tag } : {}),
    ...(recipient ? { recipient } : {}),
    page,
    pageSize: PAGE_SIZE,
  });

  const testMutation = useSendTestDigest();
  const resendMutation = useResendDigest();
  const [actionMsg, setActionMsg] = useState<{
    kind: "success" | "danger";
    text: string;
  } | null>(null);

  function serverMessage(err: unknown, fallback: string): string {
    return (err as { message?: string } | undefined)?.message ?? fallback;
  }

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
    {
      key: "actions",
      label: "",
      size: "110px",
      align: "right",
      // Resend only makes sense for a FAILED digest — it re-triggers the typed
      // email with fresh data (not a byte replay).
      render: (row) =>
        row.status === "failed" && row.tag === "weekly-digest" ? (
          <Button
            variant="secondary"
            size="sm"
            loading={resendMutation.isPending}
            onClick={() =>
              resendMutation.mutate(
                { body: { recipient: row.recipient } },
                {
                  onSuccess: () => {
                    setActionMsg({
                      kind: "success",
                      text: `Resend queued for ${row.recipient}.`,
                    });
                    void refetch();
                  },
                  onError: (err: unknown) =>
                    setActionMsg({
                      kind: "danger",
                      text: serverMessage(err, "Failed to queue the resend."),
                    }),
                },
              )
            }
          >
            Resend
          </Button>
        ) : null,
    },
  ];

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <PageHeader title="Email Log" />
        <Button
          variant="secondary"
          size="sm"
          loading={testMutation.isPending}
          onClick={() =>
            testMutation.mutate(
              {},
              {
                onSuccess: (res) => {
                  setActionMsg({
                    kind: res.status === "sent" ? "success" : "danger",
                    text:
                      res.status === "sent"
                        ? "Test digest sent to your address."
                        : "Test digest failed to send — check the provider.",
                  });
                  void refetch();
                },
                onError: (err: unknown) =>
                  setActionMsg({
                    kind: "danger",
                    text: serverMessage(err, "Failed to send the test digest."),
                  }),
              },
            )
          }
        >
          Send test digest to me
        </Button>
      </div>
      {actionMsg ? (
        <Alert
          intent={actionMsg.kind}
          title={actionMsg.text}
          className="mb-4"
          compact
        />
      ) : null}
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
          options={[
            { value: "", label: "All statuses" },
            { value: "sent", label: "Sent" },
            { value: "failed", label: "Failed" },
          ]}
          ariaLabel="Filter by status"
          className="w-36"
        />
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
        footer={
          <Pagination
            page={page}
            pageCount={totalPages}
            total={total}
            onPageChange={setPage}
          />
        }
      />
    </section>
  );
}
