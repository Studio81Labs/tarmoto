import { useEffect, useState } from "react";
import type { components } from "@tarmoto/openapi-client";
import { Alert, Button, Pill } from "@tarmoto/ui";
import { Dialog } from "../Dialog.js";
import { PreviewPane } from "./PreviewPane.js";
import {
  useTemplateHistory,
  useRevertVersion,
} from "../../data/useAdminEmailTemplates.js";

type Version = components["schemas"]["EmailTemplateVersionDto"];

function serverMessage(err: unknown, fallback: string): string {
  const m = (err as { message?: string | string[] } | undefined)?.message;
  if (Array.isArray(m)) return m.join("; ");
  return m ?? fallback;
}

/**
 * Right-side slide-over listing a template's published + archived versions.
 * `support` can view and preview any version; `super_admin` can revert (re-
 * publish a prior version's content as a new version). The revert mutation and
 * its confirm live here; `onReverted` lets the parent editor refresh its
 * detail + the templates list.
 */
export function VersionHistoryDrawer({
  open,
  tag,
  locale,
  isSuper,
  onClose,
  onReverted,
}: {
  open: boolean;
  tag: string;
  locale: string;
  isSuper: boolean;
  onClose: () => void;
  onReverted: () => void;
}) {
  const history = useTemplateHistory(tag, locale, open);
  const revert = useRevertVersion();
  const [previewVersion, setPreviewVersion] = useState<number | null>(null);
  const [confirmVersion, setConfirmVersion] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !revert.isPending && confirmVersion === null)
        onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, revert.isPending, confirmVersion, onClose]);

  if (!open) return null;

  const versions = (history.data ?? []) as Version[];
  const preview = versions.find((v) => v.version === previewVersion) ?? null;

  function doRevert(version: number) {
    setError(null);
    revert.mutate(
      {
        params: {
          // The revert endpoint's `:version` route segment is a raw string
          // on the wire (the backend parses + validates it server-side), so
          // the generated path-param type is `string` even though
          // `EmailTemplateVersionDto.version` — and every version number
          // tracked in this component's state — is a `number`. Cast at this
          // single call site rather than stringifying the value: a numeric
          // string interpolates into the URL identically, so this changes
          // nothing at runtime and keeps `Version`/state typed as `number`
          // everywhere else.
          path: { tag, locale, version: version as unknown as string },
        },
      },
      {
        onSuccess: () => {
          setConfirmVersion(null);
          setPreviewVersion(null);
          void history.refetch();
          onReverted();
        },
        onError: (err: unknown) => {
          setConfirmVersion(null);
          setError(serverMessage(err, "Failed to revert."));
        },
      },
    );
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Version history"
      className="fixed inset-0 z-40 flex justify-end bg-ink/40 backdrop-blur-sm"
      onClick={() => !revert.isPending && confirmVersion === null && onClose()}
    >
      <div
        className="flex h-full w-full max-w-xl flex-col overflow-y-auto border-l border-line bg-cream shadow-[0_24px_60px_rgba(14,14,16,0.2)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-base font-extrabold text-ink">Version history</h2>
          <button
            type="button"
            onClick={() => !revert.isPending && onClose()}
            aria-label="Close"
            disabled={revert.isPending}
            className="-mr-1 text-[22px] leading-none text-ink/40 transition hover:text-ink disabled:opacity-40"
          >
            ×
          </button>
        </div>

        <div className="flex flex-col gap-3 px-5 py-4">
          {error ? <Alert intent="danger" title={error} compact /> : null}
          {history.isPending ? (
            <p className="text-sm text-fg-dim">Loading…</p>
          ) : versions.length === 0 ? (
            <p className="text-sm text-fg-dim">No published versions yet.</p>
          ) : (
            versions.map((v) => (
              <div
                key={v.version}
                className="rounded-lg border border-line p-3"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold text-ink">
                    v{v.version}
                  </span>
                  <Pill variant={v.status === "published" ? "accent" : "ghost"}>
                    {v.status === "published" ? "Live" : "Archived"}
                  </Pill>
                  <span className="ml-auto text-xs text-fg-dim">
                    {/* Author and date are separate elements (not sibling
                        text nodes in one span) so each renders as its own
                        exact-matchable text node — a bare `{a}{b}` pair here
                        concatenates into one composite string ("jane@… ·
                        7/10/2026") that an exact `getByText(email)` can't
                        match. */}
                    <span>{v.author ?? "System"}</span>
                    {v.publishedAt ? (
                      <span>{` · ${new Date(v.publishedAt).toLocaleDateString()}`}</span>
                    ) : null}
                  </span>
                </div>
                <div className="mt-2 flex gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      setPreviewVersion((cur) =>
                        cur === v.version ? null : v.version,
                      )
                    }
                  >
                    {previewVersion === v.version ? "Hide preview" : "Preview"}
                  </Button>
                  {isSuper ? (
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={revert.isPending}
                      onClick={() => setConfirmVersion(v.version)}
                    >
                      Revert
                    </Button>
                  ) : null}
                </div>
              </div>
            ))
          )}

          {preview ? (
            <PreviewPane
              key={preview.version}
              tag={tag}
              locale={locale}
              subject={preview.subject}
              blocks={preview.blocks}
            />
          ) : null}
        </div>
      </div>

      <Dialog
        open={confirmVersion !== null}
        title="Revert to this version?"
        onClose={() => setConfirmVersion(null)}
        busy={revert.isPending}
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              disabled={revert.isPending}
              onClick={() => setConfirmVersion(null)}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={revert.isPending}
              onClick={() =>
                confirmVersion !== null && doRevert(confirmVersion)
              }
            >
              Revert now
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink">
          This re-publishes v{confirmVersion} as a new live version for{" "}
          <strong>{tag}</strong>. The current live version is kept in history.
        </p>
      </Dialog>
    </div>
  );
}
