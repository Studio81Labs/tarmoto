import { useState } from "react";
import type { components } from "@tarmoto/openapi-client";
import {
  Alert,
  Button,
  DataTable,
  type DataTableColumn,
  PageHeader,
  Pill,
  Textarea,
} from "@tarmoto/ui";
import {
  useAdminFeatureFlags,
  useAdminFeatureFlagUsers,
  useClearFeatureGlobal,
  useSetFeatureGlobal,
} from "../data/useAdminFlags.js";
import {
  useLaunchTier,
  useSetLaunchTier,
} from "../data/useAdminSystemSettings.js";
import { Dialog } from "../components/Dialog.js";

type FeatureFlag = components["schemas"]["AdminFeatureFlagDto"];
type FlagUserRow = components["schemas"]["AdminFeatureFlagUserRowDto"];
type LaunchTier = components["schemas"]["SetLaunchTierDto"]["tier"];

function readErrorMessage(err: unknown, fallback: string): string {
  const statusCode = (err as { statusCode?: number } | undefined)?.statusCode;
  const serverMsg = (err as { message?: string } | undefined)?.message;
  if (statusCode === 404)
    return serverMsg ?? "Unknown feature key (not in the registry).";
  if (statusCode === 403) return serverMsg ?? "Permission denied.";
  return serverMsg ?? fallback;
}

export function FeatureFlagsScreen() {
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [expandedFeature, setExpandedFeature] = useState<string | null>(null);

  // Force-off dialog state (kill switch — reason is mandatory)
  const [forceOffTarget, setForceOffTarget] = useState<FeatureFlag | null>(
    null,
  );
  const [forceOffReason, setForceOffReason] = useState("");
  const [forceOffError, setForceOffError] = useState<string | null>(null);

  const { data, isPending, error, refetch } = useAdminFeatureFlags();
  const setGlobalMutation = useSetFeatureGlobal();
  const clearGlobalMutation = useClearFeatureGlobal();

  const rows: FeatureFlag[] = data?.flags ?? [];

  function forceOn(row: FeatureFlag) {
    setPendingKey(row.feature);
    setActionError(null);
    setGlobalMutation.mutate(
      {
        params: { path: { feature: row.feature } },
        body: { state: "force_on" },
      },
      {
        onSuccess: () => void refetch(),
        onError: (err: unknown) =>
          setActionError(readErrorMessage(err, "Failed to force the flag on.")),
        onSettled: () => setPendingKey(null),
      },
    );
  }

  function clearGlobal(row: FeatureFlag) {
    setPendingKey(row.feature);
    setActionError(null);
    clearGlobalMutation.mutate(
      { params: { path: { feature: row.feature } } },
      {
        onSuccess: () => void refetch(),
        onError: (err: unknown) =>
          setActionError(
            readErrorMessage(err, "Failed to clear the global override."),
          ),
        onSettled: () => setPendingKey(null),
      },
    );
  }

  function handleForceOffSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!forceOffTarget) return;
    const reason = forceOffReason.trim();
    if (!reason) {
      setForceOffError("A reason is required to force a feature off.");
      return;
    }
    setForceOffError(null);
    setGlobalMutation.mutate(
      {
        params: { path: { feature: forceOffTarget.feature } },
        body: { state: "force_off", reason },
      },
      {
        onSuccess: () => {
          setForceOffTarget(null);
          setForceOffReason("");
          void refetch();
        },
        onError: (err: unknown) =>
          setForceOffError(
            readErrorMessage(err, "Failed to force the flag off."),
          ),
      },
    );
  }

  const columns: ReadonlyArray<DataTableColumn<FeatureFlag>> = [
    {
      key: "feature",
      label: "Feature",
      primary: true,
      render: (row) => row.feature,
    },
    {
      key: "description",
      label: "Description",
      render: (row) => row.description,
    },
    {
      key: "tiers",
      label: "Tiers",
      size: "160px",
      render: (row) =>
        row.tiers.length ? (
          <div className="flex flex-wrap gap-1">
            {row.tiers.map((tier) => (
              <Pill key={tier} variant="ghost">
                {tier}
              </Pill>
            ))}
          </div>
        ) : (
          "—"
        ),
    },
    {
      key: "default_value",
      label: "Default",
      size: "90px",
      render: (row) => (
        <Pill variant={row.default_value ? "accent" : "ghost"}>
          {row.default_value ? "on" : "off"}
        </Pill>
      ),
    },
    {
      key: "global_state",
      label: "Global override",
      size: "130px",
      render: (row) =>
        row.global_state ? (
          <Pill
            variant={row.global_state === "force_off" ? "danger" : "accent"}
            {...(row.global_reason ? { title: row.global_reason } : {})}
          >
            {row.global_state}
          </Pill>
        ) : (
          "—"
        ),
    },
    {
      key: "overridden_user_count",
      label: "Overridden users",
      size: "140px",
      numeric: true,
      render: (row) => row.overridden_user_count,
    },
    {
      key: "actions",
      label: "",
      size: "300px",
      align: "right",
      render: (row) => (
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              setExpandedFeature(
                expandedFeature === row.feature ? null : row.feature,
              )
            }
          >
            {expandedFeature === row.feature ? "Hide overrides" : "Overrides"}
          </Button>
          {row.global_state !== "force_on" ? (
            <Button
              variant="secondary"
              size="sm"
              loading={pendingKey === row.feature}
              onClick={() => forceOn(row)}
            >
              Force on
            </Button>
          ) : null}
          {row.global_state !== "force_off" ? (
            <Button
              variant="danger"
              size="sm"
              loading={pendingKey === row.feature}
              onClick={() => {
                setForceOffReason("");
                setForceOffError(null);
                setForceOffTarget(row);
              }}
            >
              Force off
            </Button>
          ) : null}
          {row.global_state ? (
            <Button
              variant="ghost"
              size="sm"
              loading={pendingKey === row.feature}
              onClick={() => clearGlobal(row)}
            >
              Clear
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <section>
      <PageHeader title="Feature Flags" />
      {error ? (
        <Alert
          intent="danger"
          title="Failed to load feature flags."
          className="mb-4"
        />
      ) : null}
      {actionError ? (
        <Alert intent="danger" title={actionError} className="mb-4" compact />
      ) : null}

      <LaunchModeCard />

      <Dialog
        open={forceOffTarget !== null}
        title={`Force off "${forceOffTarget?.feature ?? ""}"`}
        onClose={() => setForceOffTarget(null)}
        busy={setGlobalMutation.isPending}
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setForceOffTarget(null)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form="force-off-form"
              variant="danger-solid"
              size="sm"
              loading={setGlobalMutation.isPending}
            >
              Force off
            </Button>
          </>
        }
      >
        {forceOffError ? (
          <Alert
            intent="danger"
            title={forceOffError}
            className="mb-4"
            compact
          />
        ) : null}
        <form
          id="force-off-form"
          onSubmit={handleForceOffSubmit}
          className="flex flex-col gap-3"
        >
          <p className="text-sm text-fg-dim">
            This is a kill switch: the feature turns off for everyone,
            regardless of tier or per-user overrides. A reason is required.
          </p>
          <Textarea
            value={forceOffReason}
            onChange={setForceOffReason}
            placeholder="Why is this feature being forced off?"
            ariaLabel="Reason"
            maxLength={500}
          />
        </form>
      </Dialog>

      <DataTable
        columns={columns}
        rows={isPending ? [] : rows}
        rowKey={(row) => row.feature}
        showCaret={false}
        emptyState={
          <span className="text-sm text-fg-dim">
            {isPending ? "—" : "No feature flags in the registry."}
          </span>
        }
        ariaLabel="Feature Flags"
      />

      {expandedFeature ? (
        <FlagOverridesPanel feature={expandedFeature} />
      ) : null}
    </section>
  );
}

function LaunchModeCard() {
  const [pendingTier, setPendingTier] = useState<LaunchTier | "off" | null>(
    null,
  );
  const [launchError, setLaunchError] = useState<string | null>(null);

  const { data, isPending, error, refetch } = useLaunchTier();
  const setLaunchTierMutation = useSetLaunchTier();

  const tier = data?.tier ?? null;

  function setTier(nextTier: LaunchTier) {
    setPendingTier(nextTier ?? "off");
    setLaunchError(null);
    setLaunchTierMutation.mutate(
      { body: { tier: nextTier } },
      {
        onSuccess: () => void refetch(),
        onError: (err: unknown) =>
          setLaunchError(
            readErrorMessage(err, "Failed to update launch mode."),
          ),
        onSettled: () => setPendingTier(null),
      },
    );
  }

  return (
    <div className="mb-6 rounded-xl border border-line bg-paper p-5">
      <h3 className="mb-4 text-sm font-semibold text-ink">Launch mode</h3>
      {error ? (
        <Alert
          intent="danger"
          title="Failed to load launch mode."
          className="mb-4"
          compact
        />
      ) : null}
      {launchError ? (
        <Alert intent="danger" title={launchError} className="mb-4" compact />
      ) : null}
      {isPending ? (
        <p className="text-sm text-fg-dim">Loading…</p>
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <Pill variant={tier ? "accent" : "ghost"}>
              {tier ? `New registrations get ${tier}` : "Off"}
            </Pill>
            {tier && data?.updated_at ? (
              <span className="text-fg-dim">
                since{" "}
                {new Date(data.updated_at).toLocaleDateString("en-GB", {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                })}
              </span>
            ) : null}
            <div className="ml-auto flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                loading={pendingTier === "off"}
                onClick={() => setTier(null)}
              >
                Off
              </Button>
              <Button
                variant="secondary"
                size="sm"
                loading={pendingTier === "pro"}
                onClick={() => setTier("pro")}
              >
                Grant Pro
              </Button>
              <Button
                variant="secondary"
                size="sm"
                loading={pendingTier === "premium"}
                onClick={() => setTier("premium")}
              >
                Grant Premium
              </Button>
            </div>
          </div>
          <p className="text-fg-dim">
            While enabled, every new registration starts on this tier (plan
            source: founder). Existing accounts are unaffected.
          </p>
        </div>
      )}
    </div>
  );
}

function FlagOverridesPanel({ feature }: { feature: string }) {
  const { data, isPending, error } = useAdminFeatureFlagUsers(
    feature,
    {},
    true,
  );

  const rows: FlagUserRow[] = data?.rows ?? [];

  const columns: ReadonlyArray<DataTableColumn<FlagUserRow>> = [
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
      key: "subscription_tier",
      label: "Tier",
      size: "110px",
      render: (row) => <Pill variant="ghost">{row.subscription_tier}</Pill>,
    },
    {
      key: "enabled",
      label: "Override",
      size: "110px",
      render: (row) => (
        <Pill variant={row.enabled ? "accent" : "danger"}>
          {row.enabled ? "force_on" : "force_off"}
        </Pill>
      ),
    },
    {
      key: "updated_at",
      label: "Updated",
      size: "130px",
      render: (row) =>
        new Date(row.updated_at).toLocaleDateString("en-GB", {
          year: "numeric",
          month: "short",
          day: "numeric",
        }),
    },
  ];

  return (
    <div className="mt-6 rounded-xl border border-line bg-paper p-5">
      <h3 className="mb-4 text-sm font-semibold text-ink">
        Overridden users — {feature}
      </h3>
      {error ? (
        <Alert
          intent="danger"
          title="Failed to load overridden users."
          className="mb-4"
          compact
        />
      ) : null}
      <DataTable
        columns={columns}
        rows={isPending ? [] : rows}
        rowKey={(row) => row.user_id}
        showCaret={false}
        emptyState={
          <span className="text-sm text-fg-dim">
            {isPending ? "—" : "No per-user overrides for this flag."}
          </span>
        }
        ariaLabel={`Overridden users for ${feature}`}
      />
    </div>
  );
}
