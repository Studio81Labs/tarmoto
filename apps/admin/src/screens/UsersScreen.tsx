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
  Toggle,
} from "@tarmoto/ui";
import {
  useAdminUsersList,
  useAdminUserDetail,
  useAdminUserNotificationPrefs,
  useUpdateUserNotificationPrefs,
  useSoftDeleteUser,
  useRestoreUser,
} from "../data/useAdminUsers.js";
import {
  useAdminUserFeatureFlags,
  useAdminUserFeatureLimits,
  useRemoveFeatureOverride,
  useRemoveLimitOverride,
  useSetFeatureOverride,
  useSetLimitOverride,
} from "../data/useAdminFlags.js";
import { Pagination } from "../components/Pagination.js";

type DeletedFilter = "active" | "deleted" | "all";
type UserRow = components["schemas"]["AdminUserRowDto"];
type UserDetail = components["schemas"]["AdminUserDetailDto"];

const PAGE_SIZE = 25;

const formatLimit = (v: number | null | undefined) =>
  v === null || v === undefined ? "∞" : String(v);

export function UsersScreen() {
  const [q, setQ] = useState("");
  const [deleted, setDeleted] = useState<DeletedFilter>("active");
  const [subscription, setSubscription] = useState("");
  const [page, setPage] = useState(1);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, isPending, error, refetch } = useAdminUsersList({
    ...(q ? { q } : {}),
    deleted,
    ...(subscription ? { subscription } : {}),
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
          options={[
            { value: "active", label: "Active" },
            { value: "deleted", label: "Deleted" },
            { value: "all", label: "All" },
          ]}
          ariaLabel="Filter by status"
          className="w-36"
        />
        <Select
          value={subscription}
          onChange={(v) => {
            setSubscription(v);
            setPage(1);
          }}
          options={[
            { value: "", label: "All subscriptions" },
            { value: "free", label: "Free" },
            { value: "premium", label: "Premium" },
            { value: "pro", label: "Pro" },
            { value: "active", label: "Active" },
            { value: "trialing", label: "Trialing" },
            { value: "past_due", label: "Past due" },
            { value: "canceled", label: "Canceled" },
          ]}
          ariaLabel="Filter by subscription"
          className="w-44"
        />
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
        footer={
          <Pagination
            page={page}
            pageCount={totalPages}
            total={total}
            onPageChange={setPage}
          />
        }
      />
      {selectedUserId ? (
        <>
          <div className="mt-6 rounded-xl border border-line bg-paper p-5">
            <h3 className="mb-4 text-sm font-semibold text-ink">User Detail</h3>
            {detailPending ? (
              <p className="text-sm text-fg-dim">Loading…</p>
            ) : detail ? (
              <UserDetailPanel detail={detail} />
            ) : null}
          </div>
          <NotificationPreferencesCard userId={selectedUserId} />
          <UserFeatureFlagsCard userId={selectedUserId} />
          {/* Keyed so a direct switch between two selected users (View on a
              different row, without Close in between) fully remounts the
              card — otherwise the draft override input (free text, unlike
              the flags card's plain buttons) would carry an unsubmitted
              value typed for the previous user into the newly selected
              user's row. */}
          <UserFeatureLimitsCard key={selectedUserId} userId={selectedUserId} />
        </>
      ) : null}
    </section>
  );
}

function NotificationPreferencesCard({ userId }: { userId: string }) {
  const { data, isPending, error, refetch } =
    useAdminUserNotificationPrefs(userId);
  const updateMutation = useUpdateUserNotificationPrefs();
  const [saveError, setSaveError] = useState<string | null>(null);

  function patch(body: Record<string, unknown>) {
    updateMutation.mutate(
      { params: { path: { id: userId } }, body },
      {
        onSuccess: () => {
          setSaveError(null);
          void refetch();
        },
        onError: (err: unknown) => {
          const msg = (err as { message?: string } | undefined)?.message;
          setSaveError(msg ?? "Failed to update notification preferences.");
        },
      },
    );
  }

  const saving = updateMutation.isPending;

  return (
    <div className="mt-4 rounded-xl border border-line bg-paper p-5">
      <h3 className="mb-4 text-sm font-semibold text-ink">
        Notification preferences
      </h3>
      {error ? (
        <Alert
          intent="danger"
          title="Failed to load notification preferences."
          className="mb-4"
          compact
        />
      ) : null}
      {saveError ? (
        <Alert intent="danger" title={saveError} className="mb-4" compact />
      ) : null}
      {isPending || !data ? (
        <p className="text-sm text-fg-dim">Loading…</p>
      ) : (
        <dl className="flex flex-col gap-4 text-sm">
          <div className="flex items-center gap-3">
            <dt className="min-w-40 text-fg-dim">Email digest</dt>
            <dd>
              <Select
                value={data.email_digest}
                onChange={(v) => {
                  if (v === "weekly" || v === "daily" || v === "never") {
                    patch({ email_digest: v });
                  }
                }}
                options={[
                  { value: "weekly", label: "Weekly" },
                  { value: "daily", label: "Daily" },
                  { value: "never", label: "Never" },
                ]}
                ariaLabel="Email digest cadence"
                className="w-40"
                disabled={saving}
              />
            </dd>
          </div>
          <div className="flex items-center gap-3">
            <dt className="min-w-40 text-fg-dim">Marketing emails</dt>
            <dd>
              <Toggle
                checked={data.marketing_emails}
                onChange={(next) => patch({ marketing_emails: next })}
                disabled={saving}
                ariaLabel="Marketing emails"
              />
            </dd>
          </div>
          <div className="flex items-center gap-3">
            <dt className="min-w-40 text-fg-dim">Timezone</dt>
            <dd className="text-ink">{data.quiet_hours_timezone}</dd>
          </div>
          <div>
            <dt className="mb-1 text-fg-dim">Categories (read-only)</dt>
            <dd>
              <div className="flex flex-col gap-1">
                {Object.entries(data.categories).map(([cat, ch]) => (
                  <div key={cat} className="flex flex-wrap items-center gap-2">
                    <span className="min-w-44 text-ink">{cat}</span>
                    <span className="text-fg-dim">
                      {[
                        ch?.email ? "email" : null,
                        ch?.push ? "push" : null,
                        ch?.in_app ? "in-app" : null,
                      ]
                        .filter(Boolean)
                        .join(", ") || "off"}
                    </span>
                  </div>
                ))}
              </div>
            </dd>
          </div>
        </dl>
      )}
    </div>
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
        <dt className="text-fg-dim">Plan source</dt>
        <dd className="text-ink">
          {detail.plan_source === "founder" ? (
            <Pill variant="ghost">founder</Pill>
          ) : (
            (detail.plan_source ?? "—")
          )}
        </dd>
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

function UserFeatureFlagsCard({ userId }: { userId: string }) {
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [flagError, setFlagError] = useState<string | null>(null);

  const { data, isPending, error, refetch } = useAdminUserFeatureFlags(userId);
  const setOverrideMutation = useSetFeatureOverride();
  const removeOverrideMutation = useRemoveFeatureOverride();

  function setOverride(feature: string, enabled: boolean) {
    setPendingKey(feature);
    setOverrideMutation.mutate(
      { params: { path: { userId, feature } }, body: { enabled } },
      {
        onSuccess: () => {
          setFlagError(null);
          void refetch();
        },
        onError: (err: unknown) => {
          const serverMsg = (err as { message?: string } | undefined)?.message;
          setFlagError(serverMsg ?? "Failed to set the feature override.");
        },
        onSettled: () => setPendingKey(null),
      },
    );
  }

  function removeOverride(feature: string) {
    setPendingKey(feature);
    removeOverrideMutation.mutate(
      { params: { path: { userId, feature } } },
      {
        onSuccess: () => {
          setFlagError(null);
          void refetch();
        },
        onError: (err: unknown) => {
          const serverMsg = (err as { message?: string } | undefined)?.message;
          setFlagError(serverMsg ?? "Failed to remove the feature override.");
        },
        onSettled: () => setPendingKey(null),
      },
    );
  }

  return (
    <div className="mt-4 rounded-xl border border-line bg-paper p-5">
      <h3 className="mb-4 text-sm font-semibold text-ink">Feature flags</h3>
      {error ? (
        <Alert
          intent="danger"
          title="Failed to load the user's feature flags."
          className="mb-4"
          compact
        />
      ) : null}
      {flagError ? (
        <Alert intent="danger" title={flagError} className="mb-4" compact />
      ) : null}
      {isPending ? (
        <p className="text-sm text-fg-dim">Loading…</p>
      ) : (
        <dl className="flex flex-col gap-3 text-sm">
          {(data?.flags ?? []).map((flag) => (
            <div
              key={flag.feature}
              className="flex flex-wrap items-center gap-3"
            >
              <div className="min-w-48">
                <dt className="text-ink">{flag.feature}</dt>
                <dd className="text-fg-dim">{flag.description}</dd>
              </div>
              <Pill variant={flag.resolved ? "accent" : "ghost"}>
                {flag.resolved ? "on" : "off"}
              </Pill>
              <span className="text-fg-dim">{flag.override_state}</span>
              <div className="ml-auto flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  loading={pendingKey === flag.feature}
                  onClick={() => setOverride(flag.feature, true)}
                >
                  Grant
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  loading={pendingKey === flag.feature}
                  onClick={() => setOverride(flag.feature, false)}
                >
                  Revoke
                </Button>
                {flag.override_state !== "default" ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={pendingKey === flag.feature}
                    onClick={() => removeOverride(flag.feature)}
                  >
                    Reset to default
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function UserFeatureLimitsCard({ userId }: { userId: string }) {
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [limitError, setLimitError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const { data, isPending, error, refetch } = useAdminUserFeatureLimits(userId);
  const setOverrideMutation = useSetLimitOverride();
  const removeOverrideMutation = useRemoveLimitOverride();

  function setOverride(feature: string, value: number | null) {
    setPendingKey(feature);
    setLimitError(null);
    setOverrideMutation.mutate(
      { params: { path: { userId, feature } }, body: { value } },
      {
        onSuccess: () => void refetch(),
        onError: (err: unknown) => {
          const serverMsg = (err as { message?: string } | undefined)?.message;
          setLimitError(serverMsg ?? "Failed to set the limit override.");
        },
        onSettled: () => setPendingKey(null),
      },
    );
  }

  function removeOverride(feature: string) {
    setPendingKey(feature);
    removeOverrideMutation.mutate(
      { params: { path: { userId, feature } } },
      {
        onSuccess: () => {
          setLimitError(null);
          void refetch();
        },
        onError: (err: unknown) => {
          const serverMsg = (err as { message?: string } | undefined)?.message;
          setLimitError(serverMsg ?? "Failed to remove the limit override.");
        },
        onSettled: () => setPendingKey(null),
      },
    );
  }

  function handleSet(feature: string) {
    const trimmedValue = (drafts[feature] ?? "").trim();
    const parsed = Number(trimmedValue);
    // `Number("")` coerces to `0`, so an empty field must be rejected
    // explicitly — otherwise a blank value silently submits as a real 0
    // (capping the user at zero) instead of prompting the operator.
    if (trimmedValue === "" || !Number.isInteger(parsed) || parsed < 0) {
      setLimitError("Value must be a non-negative integer.");
      return;
    }
    setOverride(feature, parsed);
  }

  return (
    <div className="mt-4 rounded-xl border border-line bg-paper p-5">
      <h3 className="mb-4 text-sm font-semibold text-ink">Feature limits</h3>
      {error ? (
        <Alert
          intent="danger"
          title="Failed to load the user's feature limits."
          className="mb-4"
          compact
        />
      ) : null}
      {limitError ? (
        <Alert intent="danger" title={limitError} className="mb-4" compact />
      ) : null}
      {isPending ? (
        <p className="text-sm text-fg-dim">Loading…</p>
      ) : (
        <dl className="flex flex-col gap-3 text-sm">
          {(data?.limits ?? []).map((limit) => (
            <div
              key={limit.feature}
              className="flex flex-wrap items-center gap-3"
            >
              <div className="min-w-48">
                <dt className="text-ink">{limit.feature}</dt>
                <dd className="text-fg-dim">{limit.description}</dd>
              </div>
              <span className="tabular-nums">
                {formatLimit(limit.resolved)}
              </span>
              {limit.override_active ? (
                <Pill variant="accent">
                  {formatLimit(limit.override_value)}
                </Pill>
              ) : null}
              <div className="ml-auto flex items-center gap-2">
                <Input
                  value={drafts[limit.feature] ?? ""}
                  onChange={(v) =>
                    setDrafts((prev) => ({ ...prev, [limit.feature]: v }))
                  }
                  type="text"
                  inputMode="numeric"
                  placeholder="value"
                  ariaLabel={`${limit.feature} override value`}
                  className="w-24"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  loading={pendingKey === limit.feature}
                  onClick={() => handleSet(limit.feature)}
                >
                  Set
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={pendingKey === limit.feature}
                  onClick={() => setOverride(limit.feature, null)}
                >
                  Unlimited
                </Button>
                {limit.override_active ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={pendingKey === limit.feature}
                    onClick={() => removeOverride(limit.feature)}
                  >
                    Remove override
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
