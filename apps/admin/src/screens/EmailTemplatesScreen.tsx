import type { components } from "@tarmoto/openapi-client";
import { Alert, DataTable, type DataTableColumn, Pill } from "@tarmoto/ui";
import { useHashRoute } from "../app/routes.js";
import { useEmailTemplates } from "../data/useAdminEmailTemplates.js";
import { EmailTemplateEditor } from "./EmailTemplateEditor.js";
import { PageHeader } from "../components/PageHeader.js";

type TemplateRow = components["schemas"]["EmailTemplateSummaryDto"];

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
      size: "160px",
      // A template can be BOTH live and have a pending draft (published, then a
      // new draft saved) — show both so the draft isn't hidden behind "Live".
      render: (row) => (
        <div className="flex flex-wrap gap-1">
          {row.hasPublished ? <Pill variant="accent">Live</Pill> : null}
          {row.hasDraft ? <Pill variant="ghost">Draft</Pill> : null}
          {!row.hasPublished && !row.hasDraft ? (
            <Pill variant="ghost">Default</Pill>
          ) : null}
        </div>
      ),
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
