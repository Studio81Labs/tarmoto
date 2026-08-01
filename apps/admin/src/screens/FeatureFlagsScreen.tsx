import { useState } from "react";
import type { components } from "@tarmoto/openapi-client";
import {
  Alert,
  Button,
  Checkbox,
  DataTable,
  type DataTableColumn,
  Input,
  PageHeader,
  Pill,
  Textarea,
} from "@tarmoto/ui";
import {
  useAdminFeatureFlags,
  useAdminFeatureFlagUsers,
  useAdminFeatureLimits,
  useAdminSystemSwitches,
  useClearFeatureGlobal,
  useClearLimitGlobal,
  useDisableSystemSwitch,
  useEnableSystemSwitch,
  useSetFeatureGlobal,
  useSetLimitGlobal,
} from "../data/useAdminFlags.js";
import {
  useLaunchTier,
  useSetLaunchTier,
} from "../data/useAdminSystemSettings.js";
import { Dialog } from "../components/Dialog.js";
import { Pagination } from "../components/Pagination.js";
import { TableHeading } from "../components/TableHeading.js";

type FeatureFlag = components["schemas"]["AdminFeatureFlagDto"];
type FlagUserRow = components["schemas"]["AdminFeatureFlagUserRowDto"];
type LaunchTier = components["schemas"]["SetLaunchTierDto"]["tier"];
type FeatureLimit = components["schemas"]["AdminFeatureLimitDto"];
type SystemSwitch = components["schemas"]["AdminSystemSwitchDto"];

const PAGE_SIZE = 25;

const formatLimit = (v: number | null | undefined) =>
  v === null || v === undefined ? "∞" : String(v);

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
        header={<TableHeading>Flags</TableHeading>}
        emptyState={
          <span className="text-sm text-fg-dim">
            {isPending ? "—" : "No feature flags in the registry."}
          </span>
        }
        ariaLabel="Feature Flags"
      />

      {/* Keyed so switching straight from one flag's overrides to another's
          (Overrides on a different row, without Hide in between) remounts the
          panel — otherwise its page state would carry over and land the new
          flag on a page it may not have. */}
      {expandedFeature ? (
        <FlagOverridesPanel key={expandedFeature} feature={expandedFeature} />
      ) : null}

      <FeatureLimitsSection />

      <SystemSwitchesSection />
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
  const [page, setPage] = useState(1);

  // Paged endpoint: without an explicit page the panel only ever showed the
  // server's first page (25 rows), with nothing to say more existed.
  const { data, isPending, error } = useAdminFeatureFlagUsers(
    feature,
    { page, pageSize: PAGE_SIZE },
    true,
  );

  const rows: FlagUserRow[] = data?.rows ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

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
    <div className="mt-6">
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
        header={<TableHeading>Overridden users — {feature}</TableHeading>}
        footer={
          <Pagination
            page={page}
            pageCount={totalPages}
            total={total}
            onPageChange={setPage}
          />
        }
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

function FeatureLimitsSection() {
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Set-override dialog state (value OR unlimited + mandatory reason).
  const [target, setTarget] = useState<FeatureLimit | null>(null);
  const [valueInput, setValueInput] = useState("");
  const [unlimited, setUnlimited] = useState(false);
  const [reason, setReason] = useState("");
  const [dialogError, setDialogError] = useState<string | null>(null);

  const { data, isPending, error, refetch } = useAdminFeatureLimits();
  const setGlobalMutation = useSetLimitGlobal();
  const clearGlobalMutation = useClearLimitGlobal();
  const rows: FeatureLimit[] = data?.limits ?? [];

  function openDialog(row: FeatureLimit) {
    setTarget(row);
    setUnlimited(row.global_active && row.global_value === null);
    setValueInput(
      row.global_active && row.global_value !== null
        ? String(row.global_value)
        : "",
    );
    setReason("");
    setDialogError(null);
  }

  function handleSetSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!target) return;
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      setDialogError("A reason is required for any global limit change.");
      return;
    }
    const trimmedValue = valueInput.trim();
    const parsed = Number(trimmedValue);
    // `Number("")` coerces to `0`, so an empty field must be rejected
    // explicitly — otherwise a blank value silently submits as a real 0
    // (blocking the feature for everyone) instead of prompting the operator.
    if (
      !unlimited &&
      (trimmedValue === "" || !Number.isInteger(parsed) || parsed < 0)
    ) {
      setDialogError("Value must be a non-negative integer (or Unlimited).");
      return;
    }
    setDialogError(null);
    setGlobalMutation.mutate(
      {
        params: { path: { feature: target.feature } },
        body: { value: unlimited ? null : parsed, reason: trimmedReason },
      },
      {
        onSuccess: () => {
          setTarget(null);
          void refetch();
        },
        onError: (err: unknown) =>
          setDialogError(
            readErrorMessage(err, "Failed to set the limit override."),
          ),
      },
    );
  }

  function clearGlobal(row: FeatureLimit) {
    setPendingKey(row.feature);
    setActionError(null);
    clearGlobalMutation.mutate(
      { params: { path: { feature: row.feature } } },
      {
        onSuccess: () => void refetch(),
        onError: (err: unknown) =>
          setActionError(
            readErrorMessage(err, "Failed to clear the limit override."),
          ),
        onSettled: () => setPendingKey(null),
      },
    );
  }

  const columns: ReadonlyArray<DataTableColumn<FeatureLimit>> = [
    {
      key: "feature",
      label: "Limit",
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
      label: "Free / Pro / Premium",
      size: "160px",
      render: (row) => (
        <span className="tabular-nums">
          {formatLimit(row.tier_values.free)} /{" "}
          {formatLimit(row.tier_values.pro)} /{" "}
          {formatLimit(row.tier_values.premium)}
        </span>
      ),
    },
    {
      key: "global",
      label: "Global override",
      size: "200px",
      render: (row) =>
        row.global_active ? (
          <div className="flex flex-col gap-0.5">
            <Pill
              variant="warning"
              {...(row.global_reason ? { title: row.global_reason } : {})}
            >
              {formatLimit(row.global_value)}
            </Pill>
            {row.global_reason ? (
              <span className="text-xs text-fg-dim">{row.global_reason}</span>
            ) : null}
          </div>
        ) : (
          <span className="text-fg-dim">—</span>
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
      size: "220px",
      align: "right",
      render: (row) => (
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="secondary"
            size="sm"
            loading={pendingKey === row.feature}
            onClick={() => openDialog(row)}
          >
            Set override
          </Button>
          {row.global_active ? (
            <Button
              variant="ghost"
              size="sm"
              loading={pendingKey === row.feature}
              onClick={() => clearGlobal(row)}
            >
              Clear override
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <div className="mt-6">
      {error ? (
        <Alert
          intent="danger"
          title="Failed to load feature limits."
          className="mb-4"
          compact
        />
      ) : null}
      {actionError ? (
        <Alert intent="danger" title={actionError} className="mb-4" compact />
      ) : null}

      <Dialog
        open={target !== null}
        title={`Set override — "${target?.feature ?? ""}"`}
        onClose={() => setTarget(null)}
        busy={setGlobalMutation.isPending}
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setTarget(null)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form="set-limit-form"
              variant="primary"
              size="sm"
              loading={setGlobalMutation.isPending}
            >
              Set override
            </Button>
          </>
        }
      >
        {dialogError ? (
          <Alert intent="danger" title={dialogError} className="mb-4" compact />
        ) : null}
        <form
          id="set-limit-form"
          onSubmit={handleSetSubmit}
          className="flex flex-col gap-3"
        >
          <p className="text-sm text-fg-dim">
            Sets a global override for this limit, replacing the tier default
            for everyone. A stricter per-user override still wins. A reason is
            required.
          </p>
          <Input
            value={valueInput}
            onChange={setValueInput}
            type="text"
            inputMode="numeric"
            placeholder="e.g. 3"
            ariaLabel="Value"
            disabled={unlimited}
          />
          <Checkbox
            checked={unlimited}
            onChange={setUnlimited}
            label="Unlimited (∞)"
          />
          <Textarea
            value={reason}
            onChange={setReason}
            placeholder="Why is this override being set?"
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
        header={<TableHeading>Limits</TableHeading>}
        emptyState={
          <span className="text-sm text-fg-dim">
            {isPending ? "—" : "No limits in the registry."}
          </span>
        }
        ariaLabel="Feature Limits"
      />
    </div>
  );
}

function SystemSwitchesSection() {
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Disable dialog state (kill switch — reason is mandatory).
  const [target, setTarget] = useState<SystemSwitch | null>(null);
  const [reason, setReason] = useState("");
  const [dialogError, setDialogError] = useState<string | null>(null);

  const { data, isPending, error, refetch } = useAdminSystemSwitches();
  const disableMutation = useDisableSystemSwitch();
  const enableMutation = useEnableSystemSwitch();
  const rows: SystemSwitch[] = data?.switches ?? [];

  function openDisableDialog(row: SystemSwitch) {
    setTarget(row);
    setReason("");
    setDialogError(null);
  }

  function handleDisableSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!target) return;
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      setDialogError("A reason is required to disable a system switch.");
      return;
    }
    setDialogError(null);
    disableMutation.mutate(
      {
        params: { path: { key: target.key } },
        body: { reason: trimmedReason },
      },
      {
        onSuccess: () => {
          setTarget(null);
          void refetch();
        },
        onError: (err: unknown) =>
          setDialogError(
            readErrorMessage(err, "Failed to disable the switch."),
          ),
      },
    );
  }

  function enable(row: SystemSwitch) {
    setPendingKey(row.key);
    setActionError(null);
    enableMutation.mutate(
      { params: { path: { key: row.key } } },
      {
        onSuccess: () => void refetch(),
        onError: (err: unknown) =>
          setActionError(readErrorMessage(err, "Failed to enable the switch.")),
        onSettled: () => setPendingKey(null),
      },
    );
  }

  const columns: ReadonlyArray<DataTableColumn<SystemSwitch>> = [
    {
      key: "key",
      label: "Switch",
      primary: true,
      render: (row) => row.key,
    },
    {
      key: "description",
      label: "Description",
      render: (row) => row.description,
    },
    {
      key: "state",
      label: "State",
      size: "220px",
      render: (row) => (
        <div className="flex flex-col gap-0.5">
          <Pill variant={row.enabled ? "ghost" : "warning"}>
            {row.enabled ? "On" : "Disabled"}
          </Pill>
          {!row.enabled && row.disabled_reason ? (
            <span className="text-xs text-fg-dim">{row.disabled_reason}</span>
          ) : null}
        </div>
      ),
    },
    {
      key: "actions",
      label: "",
      size: "140px",
      align: "right",
      render: (row) => (
        <div className="flex items-center justify-end gap-2">
          {row.enabled ? (
            <Button
              variant="danger"
              size="sm"
              loading={pendingKey === row.key}
              onClick={() => openDisableDialog(row)}
            >
              Disable
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              loading={pendingKey === row.key}
              onClick={() => enable(row)}
            >
              Enable
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="mt-6">
      {error ? (
        <Alert
          intent="danger"
          title="Failed to load system switches."
          className="mb-4"
          compact
        />
      ) : null}
      {actionError ? (
        <Alert intent="danger" title={actionError} className="mb-4" compact />
      ) : null}

      <Dialog
        open={target !== null}
        title={`Disable "${target?.key ?? ""}"`}
        onClose={() => setTarget(null)}
        busy={disableMutation.isPending}
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setTarget(null)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form="disable-switch-form"
              variant="danger-solid"
              size="sm"
              loading={disableMutation.isPending}
            >
              Disable
            </Button>
          </>
        }
      >
        {dialogError ? (
          <Alert intent="danger" title={dialogError} className="mb-4" compact />
        ) : null}
        <form
          id="disable-switch-form"
          onSubmit={handleDisableSubmit}
          className="flex flex-col gap-3"
        >
          <p className="text-sm text-fg-dim">
            This is a kill switch: the subsystem turns off for everyone. A
            reason is required.
          </p>
          <Textarea
            value={reason}
            onChange={setReason}
            placeholder="Why is this subsystem being disabled?"
            ariaLabel="Reason"
            maxLength={500}
          />
        </form>
      </Dialog>

      <DataTable
        columns={columns}
        rows={isPending ? [] : rows}
        rowKey={(row) => row.key}
        showCaret={false}
        header={<TableHeading>System switches</TableHeading>}
        emptyState={
          <span className="text-sm text-fg-dim">
            {isPending ? "—" : "No system switches in the registry."}
          </span>
        }
        ariaLabel="System Switches"
      />
    </div>
  );
}
