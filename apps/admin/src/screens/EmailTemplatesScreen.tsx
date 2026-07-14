import type { components } from "@tarmoto/openapi-client";
import {
  Alert,
  DataTable,
  type DataTableColumn,
  PageHeader,
  Pill,
} from "@tarmoto/ui";
import { useHashRoute } from "../app/routes.js";
import { useEmailTemplates } from "../data/useAdminEmailTemplates.js";
import { EmailTemplateEditor } from "./EmailTemplateEditor.js";

type TemplateRow = components["schemas"]["EmailTemplateSummaryDto"];

function statusOf(row: TemplateRow): {
  label: string;
  variant: "accent" | "ghost";
} {
  if (row.hasPublished) return { label: "Live", variant: "accent" };
  if (row.hasDraft) return { label: "Draft", variant: "ghost" };
  return { label: "Default", variant: "ghost" };
}

export function EmailTemplatesScreen() {
  // Both hooks called unconditionally (rules of hooks) before branching.
  const { params, navigate } = useHashRoute();
  const templates = useEmailTemplates();

  const editorTag = params[0];
  if (editorTag) {
    return (
      <EmailTemplateEditor
        tag={editorTag}
        locale={params[1] ?? "en"}
        onBack={() => navigate("email-templates")}
      />
    );
  }

  const { data, isPending, error } = templates;
  const rows: TemplateRow[] = data ?? [];

  const columns: ReadonlyArray<DataTableColumn<TemplateRow>> = [
    { key: "label", label: "Template", primary: true },
    {
      key: "status",
      label: "Status",
      size: "140px",
      render: (row) => {
        const s = statusOf(row);
        return <Pill variant={s.variant}>{s.label}</Pill>;
      },
    },
    {
      key: "legalSensitive",
      label: "",
      size: "160px",
      render: (row) =>
        row.legalSensitive ? (
          <Pill variant="danger">⚠ Legal-sensitive</Pill>
        ) : null,
    },
  ];

  return (
    <section>
      <PageHeader title="Email Templates" />
      {error ? (
        <Alert
          intent="danger"
          title="Failed to load templates."
          className="my-4"
        />
      ) : null}
      <DataTable
        columns={columns}
        rows={isPending ? [] : rows}
        rowKey={(row) => row.tag}
        onRowClick={(row) => navigate(`email-templates/${row.tag}/en`)}
        emptyState={
          <span className="text-sm text-fg-dim">
            {isPending ? "—" : "No templates."}
          </span>
        }
        ariaLabel="Editable email templates"
      />
    </section>
  );
}
