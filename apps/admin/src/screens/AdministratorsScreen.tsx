import { useState } from "react";
import type { components } from "@tarmoto/openapi-client";
import {
  Alert,
  Button,
  DataTable,
  type DataTableColumn,
  Input,
  Pill,
  Select,
} from "@tarmoto/ui";
import {
  useAdminAdminsList,
  useCreateAdmin,
  usePatchAdmin,
} from "../data/useAdminAdmins.js";
import { ROLE_RANK } from "../lib/roleRank.js";
import { Dialog } from "../components/Dialog.js";
import { PageHeader } from "../components/PageHeader.js";

type AdminRow = components["schemas"]["AdminRowDto"];
type AdminRoleType = AdminRow["role"];
type AdminMode = "password" | "sso-only";

const ALL_ROLES: AdminRoleType[] = [
  "read_only",
  "support",
  "admin",
  "super_admin",
];

const ROLE_LABEL: Record<AdminRoleType, string> = {
  read_only: "Read-only",
  support: "Support",
  admin: "Admin",
  super_admin: "Super Admin",
};

/**
 * Maps a server error from a patch mutation to a user-facing message.
 * `openapi-react-query` throws the parsed Nest error body
 * (`{ statusCode, message, error }`), not a `Response` object — so we read
 * `statusCode`, not `status`. The server `message` is preferred when present.
 */
function mapPatchError(err: unknown, fallback: string): string {
  const statusCode = (err as { statusCode?: number } | undefined)?.statusCode;
  const serverMsg = (err as { message?: string } | undefined)?.message;
  if (statusCode === 409)
    return (
      serverMsg ??
      "Cannot make this change: it would remove the last super admin."
    );
  if (statusCode === 403)
    return (
      serverMsg ??
      "Permission denied: you don't have permission to make this change."
    );
  return serverMsg ?? fallback;
}

/**
 * Returns the roles that `currentRole` is permitted to assign.
 *   - super_admin → all four roles
 *   - all other actors → only roles with a strictly lower rank
 */
function assignableRoles(currentRole: AdminRoleType): AdminRoleType[] {
  if (currentRole === "super_admin") return ALL_ROLES;
  return ALL_ROLES.filter((role) => ROLE_RANK[role] < ROLE_RANK[currentRole]);
}

/**
 * Returns true when `actorRole` is allowed to manage an account with
 * `targetRole`. Mirrors the server `canManageAdminRole` rule:
 *   - super_admin actors may manage any role, including peer super_admins
 *   - all other actors require strict rank superiority
 */
function canManage(
  actorRole: AdminRoleType,
  targetRole: AdminRoleType,
): boolean {
  if (actorRole === "super_admin") return true;
  return ROLE_RANK[actorRole] > ROLE_RANK[targetRole];
}

export interface AdministratorsScreenProps {
  currentRole: AdminRoleType;
  currentAdminId: string;
}

export function AdministratorsScreen({
  currentRole,
  currentAdminId,
}: AdministratorsScreenProps) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [patchError, setPatchError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  // New-admin form state
  const [addOpen, setAddOpen] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState<AdminRoleType>("support");
  const [newMode, setNewMode] = useState<AdminMode>("sso-only");
  const [newPassword, setNewPassword] = useState("");

  const { data, isPending, error, refetch } = useAdminAdminsList();
  const createMutation = useCreateAdmin();
  const patchMutation = usePatchAdmin();

  const rows: AdminRow[] = data ?? [];

  const columns: ReadonlyArray<DataTableColumn<AdminRow>> = [
    {
      key: "email",
      label: "Email",
      primary: true,
    },
    {
      key: "role",
      label: "Role",
      size: "140px",
      render: (row) => <Pill variant="ghost">{row.role}</Pill>,
    },
    {
      key: "status",
      label: "Status",
      size: "110px",
      render: (row) => (
        <Pill variant={row.status === "active" ? "accent" : "danger"}>
          {row.status}
        </Pill>
      ),
    },
    {
      key: "last_login_at",
      label: "Last Login",
      size: "150px",
      render: (row) =>
        row.last_login_at
          ? new Date(row.last_login_at).toLocaleDateString("en-GB", {
              year: "numeric",
              month: "short",
              day: "numeric",
            })
          : "—",
    },
    {
      key: "actions",
      label: "",
      size: "280px",
      align: "right",
      render: (row) => {
        if (!canManage(currentRole, row.role) || row.id === currentAdminId) {
          return null;
        }
        const isActive = row.status === "active";
        return (
          <div className="flex items-center justify-end gap-2">
            <Select
              value={row.role}
              onChange={(v) => {
                setPendingId(row.id);
                setPatchError(null);
                patchMutation.mutate(
                  {
                    params: { path: { id: row.id } },
                    body: { role: v as AdminRoleType },
                  },
                  {
                    onSuccess: () => void refetch(),
                    onError: (err: unknown) =>
                      setPatchError(
                        mapPatchError(err, "Failed to update role."),
                      ),
                    onSettled: () => setPendingId(null),
                  },
                );
              }}
              options={assignableRoles(currentRole).map((role) => ({
                value: role,
                label: ROLE_LABEL[role],
              }))}
              ariaLabel={`Role for ${row.email}`}
              className="w-32"
              tone="cream"
            />
            <Button
              variant={isActive ? "danger" : "secondary"}
              size="sm"
              loading={pendingId === row.id}
              onClick={() => {
                setPendingId(row.id);
                setPatchError(null);
                patchMutation.mutate(
                  {
                    params: { path: { id: row.id } },
                    body: { active: !isActive },
                  },
                  {
                    onSuccess: () => void refetch(),
                    onError: (err: unknown) =>
                      setPatchError(
                        mapPatchError(err, "Failed to update status."),
                      ),
                    onSettled: () => setPendingId(null),
                  },
                );
              }}
            >
              {isActive ? "Disable" : "Enable"}
            </Button>
          </div>
        );
      },
    },
  ];

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError(null);
    createMutation.mutate(
      {
        body: {
          email: newEmail,
          role: newRole,
          mode: newMode,
          ...(newMode === "password" ? { password: newPassword } : {}),
        },
      },
      {
        onSuccess: () => {
          setNewEmail("");
          setNewPassword("");
          setNewRole("support");
          setNewMode("sso-only");
          setAddOpen(false);
          void refetch();
        },
        onError: (err: unknown) => {
          const statusCode = (
            err as
              | {
                  statusCode?: number;
                }
              | undefined
          )?.statusCode;
          const serverMsg = (err as { message?: string } | undefined)?.message;
          if (statusCode === 409) {
            setCreateError(
              serverMsg ?? "An admin with this email already exists.",
            );
          } else if (statusCode === 403) {
            setCreateError(
              serverMsg ?? "You don't have permission to create this role.",
            );
          } else {
            setCreateError(
              serverMsg ?? "Failed to create admin. Please try again.",
            );
          }
        },
      },
    );
  }

  return (
    <section>
      <PageHeader
        title="Administrators"
        right={
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setNewEmail("");
              setNewPassword("");
              setNewRole("support");
              setNewMode("sso-only");
              setCreateError(null);
              setAddOpen(true);
            }}
          >
            Add Administrator
          </Button>
        }
      />
      {error ? (
        <Alert
          intent="danger"
          title="Failed to load administrators."
          className="mb-4"
        />
      ) : null}
      {patchError ? (
        <Alert intent="danger" title={patchError} className="mb-4" compact />
      ) : null}
      <DataTable
        columns={columns}
        rows={isPending ? [] : rows}
        rowKey={(row) => row.id}
        showCaret={false}
        emptyState={
          <span className="text-sm text-fg-dim">
            {isPending ? "—" : "No administrators found."}
          </span>
        }
        ariaLabel="Administrators"
      />
      <Dialog
        open={addOpen}
        title="Add Administrator"
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
              form="new-admin-form"
              variant="primary"
              size="sm"
              loading={createMutation.isPending}
            >
              Add Administrator
            </Button>
          </>
        }
      >
        {createError ? (
          <Alert intent="danger" title={createError} className="mb-4" compact />
        ) : null}
        <form
          id="new-admin-form"
          onSubmit={handleCreate}
          className="flex flex-col gap-3"
        >
          <Input
            value={newEmail}
            onChange={setNewEmail}
            type="email"
            placeholder="admin@tarmoto.app"
            ariaLabel="Email"
          />
          <Select
            value={newRole}
            onChange={(v) => setNewRole(v as AdminRoleType)}
            options={assignableRoles(currentRole).map((role) => ({
              value: role,
              label: ROLE_LABEL[role],
            }))}
            ariaLabel="Role"
          />
          <Select
            value={newMode}
            onChange={(v) => setNewMode(v as AdminMode)}
            options={[
              { value: "sso-only", label: "SSO only" },
              { value: "password", label: "Password" },
            ]}
            ariaLabel="Authentication mode"
          />
          {newMode === "password" ? (
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Password"
              aria-label="Password"
              className="w-full rounded-lg border border-line-strong bg-paper px-3 py-2 font-sans text-sm text-ink placeholder:text-fg-mute transition focus:border-accent focus:outline-none"
            />
          ) : null}
        </form>
      </Dialog>
    </section>
  );
}
