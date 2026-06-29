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
} from "@tarmoto/ui";
import {
  useAdminFlagsList,
  useCreateFlag,
  useDeleteFlag,
  useUpdateFlag,
} from "../data/useAdminFlags.js";
import { Dialog } from "../components/Dialog.js";

type FeatureFlag = components["schemas"]["FeatureFlagDto"];

function readErrorMessage(err: unknown, fallback: string): string {
  const statusCode = (err as { statusCode?: number } | undefined)?.statusCode;
  const serverMsg = (err as { message?: string } | undefined)?.message;
  if (statusCode === 404)
    return (
      serverMsg ??
      "Flag not found (it may have been deleted by another session)."
    );
  if (statusCode === 403) return serverMsg ?? "Permission denied.";
  return serverMsg ?? fallback;
}

export function FeatureFlagsScreen() {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  // New-flag form state
  const [addOpen, setAddOpen] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newDescription, setNewDescription] = useState("");

  const { data, isPending, error, refetch } = useAdminFlagsList();
  const createMutation = useCreateFlag();
  const updateMutation = useUpdateFlag();
  const deleteMutation = useDeleteFlag();

  const rows: FeatureFlag[] = data ?? [];

  const columns: ReadonlyArray<DataTableColumn<FeatureFlag>> = [
    {
      key: "key",
      label: "Key",
      primary: true,
      render: (row) => row.key,
    },
    {
      key: "enabled",
      label: "Enabled",
      size: "100px",
      render: (row) => (
        <Pill variant={row.enabled ? "accent" : "ghost"}>
          {row.enabled ? "enabled" : "disabled"}
        </Pill>
      ),
    },
    {
      key: "description",
      label: "Description",
      render: (row) => row.description ?? "—",
    },
    {
      key: "actions",
      label: "",
      size: "200px",
      align: "right",
      render: (row) => (
        <div className="flex items-center justify-end gap-2">
          <Button
            variant={row.enabled ? "danger" : "secondary"}
            size="sm"
            loading={pendingId === row.id}
            onClick={() => {
              setPendingId(row.id);
              setActionError(null);
              updateMutation.mutate(
                {
                  params: { path: { id: row.id } },
                  body: { enabled: !row.enabled },
                },
                {
                  onSuccess: () => void refetch(),
                  onError: (err: unknown) =>
                    setActionError(
                      readErrorMessage(err, "Failed to update flag."),
                    ),
                  onSettled: () => setPendingId(null),
                },
              );
            }}
          >
            {row.enabled ? "Disable" : "Enable"}
          </Button>
          <Button
            variant="danger"
            size="sm"
            loading={pendingId === row.id}
            onClick={() => {
              if (!window.confirm(`Delete flag "${row.key}"?`)) return;
              setPendingId(row.id);
              setActionError(null);
              deleteMutation.mutate(
                { params: { path: { id: row.id } } },
                {
                  onSuccess: () => void refetch(),
                  onError: (err: unknown) =>
                    setActionError(
                      readErrorMessage(err, "Failed to delete flag."),
                    ),
                  onSettled: () => setPendingId(null),
                },
              );
            }}
          >
            Delete
          </Button>
        </div>
      ),
    },
  ];

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError(null);
    createMutation.mutate(
      { body: { key: newKey, enabled: false, description: newDescription } },
      {
        onSuccess: () => {
          setNewKey("");
          setNewDescription("");
          setAddOpen(false);
          void refetch();
        },
        onError: (err: unknown) => {
          const statusCode = (err as { statusCode?: number } | undefined)
            ?.statusCode;
          const serverMsg = (err as { message?: string } | undefined)?.message;
          if (statusCode === 409) {
            setCreateError(serverMsg ?? "A flag with this key already exists.");
          } else if (statusCode === 400) {
            setCreateError(serverMsg ?? "Invalid flag key format.");
          } else {
            setCreateError(
              serverMsg ?? "Failed to create flag. Please try again.",
            );
          }
        },
      },
    );
  }

  return (
    <section>
      <PageHeader
        title="Feature Flags"
        right={
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setNewKey("");
              setNewDescription("");
              setCreateError(null);
              setAddOpen(true);
            }}
          >
            New Flag
          </Button>
        }
      />
      {error ? (
        <Alert
          intent="danger"
          title="Failed to load feature flags."
          className="mb-4"
        />
      ) : null}

      <Dialog
        open={addOpen}
        title="New Feature Flag"
        onClose={() => setAddOpen(false)}
        busy={createMutation.isPending}
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setAddOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form="new-flag-form"
              variant="primary"
              size="sm"
              loading={createMutation.isPending}
            >
              Create Flag
            </Button>
          </>
        }
      >
        {createError ? (
          <Alert intent="danger" title={createError} className="mb-4" compact />
        ) : null}
        <form
          id="new-flag-form"
          onSubmit={handleCreate}
          className="flex flex-col gap-3"
        >
          <Input
            value={newKey}
            onChange={setNewKey}
            placeholder="e.g. group_rides"
            ariaLabel="Key"
          />
          <Input
            value={newDescription}
            onChange={setNewDescription}
            placeholder="Optional description"
            ariaLabel="Description"
          />
        </form>
      </Dialog>

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
            {isPending ? "—" : "No feature flags found."}
          </span>
        }
        ariaLabel="Feature Flags"
      />
    </section>
  );
}
