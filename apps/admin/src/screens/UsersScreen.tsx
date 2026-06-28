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
  useAdminUsersList,
  useAdminUserDetail,
  useSoftDeleteUser,
  useRestoreUser,
} from "../data/useAdminUsers.js";

type DeletedFilter = "active" | "deleted" | "all";
type UserRow = components["schemas"]["AdminUserRowDto"];
type UserDetail = components["schemas"]["AdminUserDetailDto"];

const PAGE_SIZE = 25;

export function UsersScreen() {
  const [q, setQ] = useState("");
  const [deleted, setDeleted] = useState<DeletedFilter>("active");
  const [subscription, setSubscription] = useState("");
  const [page, setPage] = useState(1);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, isPending, error, refetch } = useAdminUsersList({
    q: q || undefined,
    deleted,
    subscription: subscription || undefined,
    page,
    pageSize: PAGE_SIZE,
  });

  const { data: detail, isPending: detailPending } =
    useAdminUserDetail(selectedUserId);

  const deleteMutation = useSoftDeleteUser();
  const restoreMutation = useRestoreUser();

  const rows: UserRow[] = data?.rows ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

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
      size: "190px",
      align: "right",
      render: (row) => (
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              setSelectedUserId(row.id === selectedUserId ? null : row.id)
            }
          >
            {row.id === selectedUserId ? "Close" : "View"}
          </Button>
          {row.deleted_at ? (
            <Button
              variant="secondary"
              size="sm"
              loading={pendingId === row.id}
              onClick={() => {
                setPendingId(row.id);
                restoreMutation.mutate(
                  { params: { path: { id: row.id } } },
                  {
                    onSuccess: () => {
                      setActionError(null);
                      void refetch();
                    },
                    onError: (err: unknown) => {
                      const serverMsg = (
                        err as { message?: string } | undefined
                      )?.message;
                      setActionError(serverMsg ?? "Failed to restore user.");
                    },
                    onSettled: () => setPendingId(null),
                  },
                );
              }}
            >
              Restore
            </Button>
          ) : (
            <Button
              variant="danger"
              size="sm"
              loading={pendingId === row.id}
              onClick={() => {
                setPendingId(row.id);
                deleteMutation.mutate(
                  { params: { path: { id: row.id } } },
                  {
                    onSuccess: () => {
                      setActionError(null);
                      void refetch();
                    },
                    onError: (err: unknown) => {
                      const serverMsg = (
                        err as { message?: string } | undefined
                      )?.message;
                      setActionError(
                        serverMsg ?? "Failed to soft-delete user.",
                      );
                    },
                    onSettled: () => setPendingId(null),
                  },
                );
              }}
            >
              Delete
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <section>
      <PageHeader title="Users" />
      {error ? (
        <Alert intent="danger" title="Failed to load users." className="mb-4" />
      ) : null}
      {actionError ? (
        <Alert intent="danger" title={actionError} className="mb-4" compact />
      ) : null}
      <div className="mb-4 flex flex-wrap gap-3">
        <Input
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(1);
          }}
          type="search"
          placeholder="Search by email or name…"
          ariaLabel="Search users"
          className="max-w-xs"
        />
        <Select
          value={deleted}
          onChange={(v) => {
            if (v === "active" || v === "deleted" || v === "all") {
              setDeleted(v);
              setPage(1);
            }
          }}
          ariaLabel="Filter by status"
          className="w-36"
        >
          <option value="active">Active</option>
          <option value="deleted">Deleted</option>
          <option value="all">All</option>
        </Select>
        <Select
          value={subscription}
          onChange={(v) => {
            setSubscription(v);
            setPage(1);
          }}
          ariaLabel="Filter by subscription"
          className="w-44"
        >
          <option value="">All subscriptions</option>
          <option value="free">Free</option>
          <option value="premium">Premium</option>
          <option value="pro">Pro</option>
          <option value="active">Active</option>
          <option value="trialing">Trialing</option>
          <option value="past_due">Past due</option>
          <option value="canceled">Canceled</option>
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
      {selectedUserId ? (
        <div className="mt-6 rounded-xl border border-line bg-paper p-5">
          <h3 className="mb-4 text-sm font-semibold text-ink">User Detail</h3>
          {detailPending ? (
            <p className="text-sm text-fg-dim">Loading…</p>
          ) : detail ? (
            <UserDetailPanel detail={detail} />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function UserDetailPanel({ detail }: { detail: UserDetail }) {
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
      <div>
        <dt className="text-fg-dim">Email verified</dt>
        <dd className="text-ink">
          {detail.email_verified_at
            ? new Date(detail.email_verified_at).toLocaleDateString("en-GB", {
                year: "numeric",
                month: "short",
                day: "numeric",
              })
            : "Not verified"}
        </dd>
      </div>
      <div>
        <dt className="text-fg-dim">Subscription tier</dt>
        <dd className="text-ink">{detail.subscription_tier}</dd>
      </div>
      <div>
        <dt className="text-fg-dim">Subscription status</dt>
        <dd className="text-ink">{detail.subscription_status}</dd>
      </div>
      {detail.subscription_current_period_end ? (
        <div>
          <dt className="text-fg-dim">Period end</dt>
          <dd className="text-ink">
            {new Date(
              detail.subscription_current_period_end,
            ).toLocaleDateString("en-GB", {
              year: "numeric",
              month: "short",
              day: "numeric",
            })}
          </dd>
        </div>
      ) : null}
      {detail.deletion_scheduled_at ? (
        <div>
          <dt className="text-fg-dim">Deletion scheduled</dt>
          <dd className="text-ink">
            {new Date(detail.deletion_scheduled_at).toLocaleDateString(
              "en-GB",
              { year: "numeric", month: "short", day: "numeric" },
            )}
          </dd>
        </div>
      ) : null}
      {detail.deletion_reason ? (
        <div>
          <dt className="text-fg-dim">Deletion reason</dt>
          <dd className="text-ink">{detail.deletion_reason}</dd>
        </div>
      ) : null}
      <div className="col-span-full mt-2">
        <dt className="mb-1 text-fg-dim">Activity</dt>
        <dd>
          <div className="flex flex-wrap gap-3">
            <span>Rides: {detail.activity.rides}</span>
            <span>Hazard reports: {detail.activity.hazardReports}</span>
            <span>Road reviews: {detail.activity.roadReviews}</span>
            <span>Trips: {detail.activity.trips}</span>
            <span>Commute routes: {detail.activity.commuteRoutes}</span>
          </div>
        </dd>
      </div>
    </dl>
  );
}
