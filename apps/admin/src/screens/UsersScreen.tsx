import { useState } from "react";
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
  useAdminUsersList,
  useSoftDeleteUser,
  useRestoreUser,
} from "../data/useAdminUsers.js";

type DeletedFilter = "active" | "deleted" | "all";

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  subscription_tier: string;
  subscription_status: string;
  created_at: string;
  deleted_at: string | null;
}

export function UsersScreen() {
  const [q, setQ] = useState("");
  const [deleted, setDeleted] = useState<DeletedFilter>("active");

  const { data, isPending, error, refetch } = useAdminUsersList({
    q: q || undefined,
    deleted,
  });

  const deleteMutation = useSoftDeleteUser();
  const restoreMutation = useRestoreUser();

  const rows: UserRow[] = data?.rows ?? [];

  const columns: ReadonlyArray<DataTableColumn<UserRow>> = [
    {
      key: "email",
      label: "Email",
      primary: true,
    },
    {
      key: "display_name",
      label: "Name",
    },
    {
      key: "subscription",
      label: "Subscription",
      size: "180px",
      render: (row) => (
        <div className="flex flex-wrap gap-1">
          <Pill variant="ghost">{row.subscription_tier}</Pill>
          <Pill
            variant={row.subscription_status === "active" ? "accent" : "danger"}
          >
            {row.subscription_status}
          </Pill>
        </div>
      ),
    },
    {
      key: "created_at",
      label: "Created",
      size: "130px",
      render: (row) =>
        new Date(row.created_at).toLocaleDateString("en-GB", {
          year: "numeric",
          month: "short",
          day: "numeric",
        }),
    },
    {
      key: "actions",
      label: "",
      size: "110px",
      align: "right",
      render: (row) =>
        row.deleted_at ? (
          <Button
            variant="secondary"
            size="sm"
            loading={restoreMutation.isPending}
            onClick={() =>
              restoreMutation.mutate(
                { params: { path: { id: row.id } } },
                { onSuccess: () => void refetch() },
              )
            }
          >
            Restore
          </Button>
        ) : (
          <Button
            variant="danger"
            size="sm"
            loading={deleteMutation.isPending}
            onClick={() =>
              deleteMutation.mutate(
                { params: { path: { id: row.id } } },
                { onSuccess: () => void refetch() },
              )
            }
          >
            Delete
          </Button>
        ),
    },
  ];

  return (
    <section>
      <PageHeader title="Users" />
      {error ? (
        <Alert intent="danger" title="Failed to load users." className="mb-4" />
      ) : null}
      <div className="mb-4 flex flex-wrap gap-3">
        <Input
          value={q}
          onChange={setQ}
          type="search"
          placeholder="Search by email or name…"
          ariaLabel="Search users"
          className="max-w-xs"
        />
        <Select
          value={deleted}
          onChange={(v) => setDeleted(v as DeletedFilter)}
          ariaLabel="Filter by status"
          className="w-36"
        >
          <option value="active">Active</option>
          <option value="deleted">Deleted</option>
          <option value="all">All</option>
        </Select>
      </div>
      <DataTable
        columns={columns}
        rows={isPending ? [] : rows}
        rowKey={(row) => row.id}
        showCaret={false}
        emptyState={
          <span className="text-sm text-fg-dim">
            {isPending ? "—" : "No users found."}
          </span>
        }
        ariaLabel="Users"
      />
    </section>
  );
}
