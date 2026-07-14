import { useState } from "react";
import type { components } from "@tarmoto/openapi-client";
import { Alert, Button } from "@tarmoto/ui";
import { usePreview } from "../../data/useAdminEmailTemplates.js";

type PreviewResponse = components["schemas"]["PreviewResponseDto"];

export function PreviewPane({
  tag,
  locale,
  subject,
  blocks,
}: {
  tag: string;
  locale: string;
  subject: string;
  blocks: components["schemas"]["EmailBlockDto"][];
}) {
  const preview = usePreview();
  const [result, setResult] = useState<PreviewResponse | null>(null);
  const [tab, setTab] = useState<"html" | "text">("html");
  const [error, setError] = useState<string | null>(null);

  function run() {
    setError(null);
    preview.mutate(
      { params: { path: { tag, locale } }, body: { subject, blocks } },
      {
        onSuccess: (res: PreviewResponse) => setResult(res),
        onError: (err: unknown) => {
          const m = (err as { message?: string | string[] } | undefined)
            ?.message;
          setError(
            Array.isArray(m)
              ? m.join("; ")
              : (m ?? "Preview failed — check the fields."),
          );
        },
      },
    );
  }

  return (
    <div className="rounded-lg border border-line p-3">
      <div className="mb-2 flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          loading={preview.isPending}
          onClick={run}
        >
          Preview
        </Button>
        {result ? (
          <div className="ml-auto flex gap-1">
            <Button
              variant={tab === "html" ? "primary" : "secondary"}
              size="sm"
              onClick={() => setTab("html")}
            >
              HTML
            </Button>
            <Button
              variant={tab === "text" ? "primary" : "secondary"}
              size="sm"
              onClick={() => setTab("text")}
            >
              Text
            </Button>
          </div>
        ) : null}
      </div>
      {error ? (
        <Alert intent="danger" title={error} compact className="mb-2" />
      ) : null}
      {result ? (
        <div>
          <p className="mb-2 text-sm">
            <span className="text-fg-dim">Subject: </span>
            <span className="text-ink">{result.subject}</span>
          </p>
          {tab === "html" ? (
            <iframe
              title="Email preview"
              srcDoc={result.html}
              sandbox=""
              className="h-[480px] w-full rounded border border-line bg-white"
            />
          ) : (
            <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap rounded border border-line bg-paper p-3 text-xs text-ink">
              {result.text}
            </pre>
          )}
        </div>
      ) : null}
    </div>
  );
}
