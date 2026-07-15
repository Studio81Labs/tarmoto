import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Input, Pill } from "@tarmoto/ui";
import { Dialog } from "../components/Dialog.js";
import {
  BlockCard,
  type EditorBlock,
} from "../components/email-template/BlockCard.js";
import { VarChips } from "../components/email-template/VarChips.js";
import { PreviewPane } from "../components/email-template/PreviewPane.js";
import { useAdminAuth } from "../auth/useAdminAuth.js";
import { canAccess } from "../lib/roleRank.js";
import {
  useEmailTemplate,
  useSaveDraft,
  useTestSend,
  usePublish,
  useReset,
} from "../data/useAdminEmailTemplates.js";

const BLOCK_TYPES: EditorBlock["type"][] = [
  "heading",
  "paragraph",
  "button",
  "stat-row",
  "divider",
  "spacer",
];

function emptyBlock(type: EditorBlock["type"]): EditorBlock {
  switch (type) {
    case "heading":
    case "paragraph":
      return { type, text: "" };
    case "stat-row":
      return { type, label: "", value: "" };
    case "button":
      return { type, label: "", urlVar: "" };
    default:
      return { type };
  }
}
function serverMessage(err: unknown, fallback: string): string {
  const m = (err as { message?: string | string[] } | undefined)?.message;
  if (Array.isArray(m)) return m.join("; ");
  return m ?? fallback;
}
function sameDoc(
  a: { subject: string; blocks: EditorBlock[] },
  b: { subject: string; blocks: EditorBlock[] },
): boolean {
  return (
    a.subject === b.subject &&
    JSON.stringify(a.blocks) === JSON.stringify(b.blocks)
  );
}

export function EmailTemplateEditor({
  tag,
  locale,
  onBack,
}: {
  tag: string;
  locale: string;
  onBack: () => void;
}) {
  const { data, isPending, error, refetch } = useEmailTemplate(tag, locale);
  const role = useAdminAuth().user?.role;
  const isSuper = role ? canAccess(role, "super_admin") : false;
  const queryClient = useQueryClient();

  const saveDraft = useSaveDraft();
  const testSend = useTestSend();
  const publish = usePublish();
  const reset = useReset();

  // EmailTemplatesScreen never unmounts across list <-> editor (hash route
  // stays "email-templates"), so the list's `useEmailTemplates` query keeps
  // its cached data unless explicitly invalidated. Save/Publish/Reset only
  // refetch this editor's DETAIL query above; without this, the list's
  // status pills (Default/Draft/Live) go stale after a successful mutation.
  function invalidateList() {
    void queryClient.invalidateQueries({
      queryKey: ["get", "/admin/email/templates"],
    });
  }

  const [subject, setSubject] = useState("");
  const [blocks, setBlocks] = useState<EditorBlock[]>([]);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<{
    kind: "success" | "danger";
    text: string;
  } | null>(null);
  const [confirm, setConfirm] = useState<null | "publish" | "reset">(null);
  const [addOpen, setAddOpen] = useState(false);

  // Mirrors subject/blocks so an in-flight mutation's onSuccess (which
  // closes over the doc it submitted) can tell whether local state has
  // since diverged — refs are stable across renders, so `.current` always
  // reflects the latest edit regardless of which render's closure reads it.
  const latestDoc = useRef({ subject, blocks });
  useEffect(() => {
    latestDoc.current = { subject, blocks };
  }, [subject, blocks]);

  // Seed the editor once per (tag, locale). A later background refetch — e.g.
  // after Save/Publish, to refresh the status pill + version — must NOT overwrite
  // the admin's in-progress edits: status/version are read from `data` in the
  // header, but subject/blocks stay owned by local state after the first load.
  const seededKey = useRef<string | null>(null);
  useEffect(() => {
    if (!data) return;
    const key = `${tag}/${locale}`;
    if (seededKey.current === key) return;
    seededKey.current = key;
    setSubject(data.subject);
    setBlocks(data.blocks);
    setDirty(false);
  }, [data, tag, locale]);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  // `beforeunload` only covers full page unloads. This screen is a hash
  // sub-route (#/email-templates/:tag/:locale) — a sidebar route click or
  // the browser Back button changes window.location.hash directly and
  // unmounts this editor with no prompt. useHashRoute (app/routes.ts)
  // derives active/params fresh from window.location.hash on every render
  // and only uses a state setter to force a re-render on `hashchange`; React
  // batches that re-render until after this synchronous handler returns. So
  // on cancel we can revert the hash before React re-renders, and the
  // editor stays mounted with local edits intact — the revert itself fires
  // another `hashchange`, which the `=== editorHash` check below no-ops.
  useEffect(() => {
    if (!dirty) return;
    const editorHash = window.location.hash;
    const onHashChange = () => {
      if (window.location.hash === editorHash) return; // our own revert, or no move
      if (window.confirm("You have unsaved changes. Leave without saving?"))
        return; // allow the navigation
      window.location.hash = editorHash; // cancel: stay on this editor
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [dirty]);

  const whitelist = data?.whitelist ?? { textVars: [], urlVars: [] };
  const status = data?.status ?? "none";
  const params = { path: { tag, locale } };

  const setSubjectDirty = (v: string) => {
    setSubject(v);
    setDirty(true);
  };
  function setBlock(i: number, next: EditorBlock) {
    setBlocks((b) => b.map((x, j) => (j === i ? next : x)));
    setDirty(true);
  }
  function moveBlock(i: number, dir: -1 | 1) {
    setBlocks((b) => {
      const j = i + dir;
      if (j < 0 || j >= b.length) return b;
      const copy = [...b];
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
      return copy;
    });
    setDirty(true);
  }
  function removeBlock(i: number) {
    setBlocks((b) => b.filter((_, j) => j !== i));
    setDirty(true);
  }
  function addBlock(type: EditorBlock["type"]) {
    setBlocks((b) => [...b, emptyBlock(type)]);
    setDirty(true);
    setAddOpen(false);
  }

  function handleSave() {
    const snapshot = { subject, blocks };
    saveDraft.mutate(
      { params, body: snapshot },
      {
        onSuccess: () => {
          setMsg({ kind: "success", text: "Draft saved." });
          // Don't clear dirty if the admin kept editing while the save was in flight.
          if (sameDoc(latestDoc.current, snapshot)) setDirty(false);
          void refetch();
          invalidateList();
        },
        onError: (err: unknown) =>
          setMsg({
            kind: "danger",
            text: serverMessage(err, "Failed to save the draft."),
          }),
      },
    );
  }
  function handleTestSend() {
    testSend.mutate(
      { params, body: { subject, blocks } },
      {
        onSuccess: (res: { status: string }) =>
          setMsg({
            kind: res.status === "sent" ? "success" : "danger",
            text:
              res.status === "sent"
                ? "Test email sent to your address."
                : "Test send failed — check the provider.",
          }),
        onError: (err: unknown) =>
          setMsg({
            kind: "danger",
            text: serverMessage(err, "Failed to send the test."),
          }),
      },
    );
  }
  function doPublish() {
    publish.mutate(
      { params },
      {
        onSuccess: () => {
          setMsg({
            kind: "success",
            text: "Published. This override is now live.",
          });
          setConfirm(null);
          void refetch();
          invalidateList();
        },
        onError: (err: unknown) => {
          setMsg({
            kind: "danger",
            text: serverMessage(err, "Failed to publish."),
          });
          setConfirm(null);
        },
      },
    );
  }
  function doReset() {
    reset.mutate(
      { params },
      {
        onSuccess: () => {
          setMsg({
            kind: "success",
            text: "Override removed — the code email renders again.",
          });
          setConfirm(null);
          // Re-seed to the fresh default ONLY when there are no unsaved edits —
          // that's the case round-1 targeted (local == the just-deleted
          // override). With edits present, keep them and stay dirty rather than
          // silently dropping the admin's in-progress work: seed-once then
          // leaves local state untouched and the dirty guard stays active.
          if (!dirty) seededKey.current = null;
          void refetch();
          invalidateList();
        },
        onError: (err: unknown) => {
          setMsg({
            kind: "danger",
            text: serverMessage(err, "Failed to reset."),
          });
          setConfirm(null);
        },
      },
    );
  }
  // onBack navigates by changing window.location.hash, which the hashchange
  // guard effect above intercepts uniformly — for this button, sidebar
  // routes, and browser Back — so this stays a plain passthrough and admins
  // don't see a double confirm.
  function handleBack() {
    onBack();
  }

  const legalSensitive = tag.startsWith("account-deletion");
  if (error)
    return <Alert intent="danger" title="Failed to load this template." />;

  return (
    <section>
      <div className="mb-4 flex items-center gap-3">
        <Button variant="secondary" size="sm" onClick={handleBack}>
          ← Templates
        </Button>
        <h2 className="text-lg font-extrabold text-ink">{data?.tag ?? tag}</h2>
        <Pill variant={status === "published" ? "accent" : "ghost"}>
          {status === "published"
            ? "Live"
            : status === "draft"
              ? "Draft"
              : "Default"}
        </Pill>
        {data ? (
          <span className="text-xs text-fg-dim">v{data.version}</span>
        ) : null}
      </div>

      {msg ? (
        <Alert intent={msg.kind} title={msg.text} compact className="mb-4" />
      ) : null}

      {isPending ? (
        <p className="text-sm text-fg-dim">Loading…</p>
      ) : (
        <div className="grid gap-4">
          <div>
            <label className="mb-1 block text-sm font-bold text-ink">
              Subject
            </label>
            <Input
              value={subject}
              onChange={setSubjectDirty}
              ariaLabel="Subject"
              placeholder="Subject (may contain {vars})"
            />
            <VarChips
              vars={whitelist.textVars}
              onInsert={(token) => setSubjectDirty(subject + token)}
            />
          </div>

          <div className="flex flex-col gap-2">
            {blocks.map((block, i) => (
              <BlockCard
                key={i}
                block={block}
                index={i}
                total={blocks.length}
                textVars={whitelist.textVars}
                urlVars={whitelist.urlVars}
                onChange={(next) => setBlock(i, next)}
                onMove={(dir) => moveBlock(i, dir)}
                onRemove={() => removeBlock(i)}
              />
            ))}
            <div className="relative">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setAddOpen((o) => !o)}
              >
                + Add block
              </Button>
              {addOpen ? (
                <div className="absolute z-10 mt-1 flex flex-col rounded-lg border border-line bg-cream p-1 shadow">
                  {BLOCK_TYPES.map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => addBlock(t)}
                      className="rounded px-3 py-1 text-left text-sm text-ink hover:bg-paper"
                    >
                      {t}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>

          <PreviewPane
            tag={tag}
            locale={locale}
            subject={subject}
            blocks={blocks}
          />

          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              size="sm"
              loading={saveDraft.isPending}
              onClick={handleSave}
            >
              Save draft
            </Button>
            <Button
              variant="secondary"
              size="sm"
              loading={testSend.isPending}
              onClick={handleTestSend}
            >
              Send test to me
            </Button>
            {isSuper ? (
              <>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => setConfirm("publish")}
                >
                  Publish
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setConfirm("reset")}
                >
                  Reset
                </Button>
              </>
            ) : null}
          </div>
        </div>
      )}

      <Dialog
        open={confirm === "publish"}
        title="Publish this override?"
        onClose={() => setConfirm(null)}
        busy={publish.isPending}
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setConfirm(null)}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={publish.isPending}
              onClick={doPublish}
            >
              Publish now
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink">
          This makes the override the live email for <strong>{tag}</strong>.
          Save your draft first if you haven't.
        </p>
        {legalSensitive ? (
          <Alert
            intent="warning"
            compact
            className="mt-3"
            title="This is a GDPR/legal notice — check the wording carefully before publishing."
          />
        ) : null}
      </Dialog>

      <Dialog
        open={confirm === "reset"}
        title="Remove the published override?"
        onClose={() => setConfirm(null)}
        busy={reset.isPending}
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setConfirm(null)}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={reset.isPending}
              onClick={doReset}
            >
              Remove override
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink">
          The code email will render again for <strong>{tag}</strong>. Your
          draft (if any) is kept.
        </p>
      </Dialog>
    </section>
  );
}
