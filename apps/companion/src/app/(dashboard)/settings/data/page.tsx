"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { signOut } from "next-auth/react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Download,
  Loader2,
  Trash2,
  X,
} from "lucide-react";
import { accountApi } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { isDeletionConfirmed } from "@/lib/account-deletion";

type ExportState =
  | { kind: "idle" }
  | { kind: "requesting" }
  | { kind: "polling"; id: string }
  | { kind: "ready"; id: string; downloadUrl: string }
  | { kind: "error"; message: string };

type ExportView = Awaited<
  ReturnType<typeof accountApi.requestDataExport>
>["data"];

// Maps a backend view to a terminal companion state, or null if the
// caller should keep polling. Centralizing the mapping keeps the POST
// handler and the polling tick in lockstep, and — importantly —
// treats `status === "ready"` as terminal regardless of whether
// `downloadUrl` came through. Without this, a (contract-breaking) ready
// row with a falsy URL would trap the user on a spinner forever.
function nextExportState(view: ExportView): ExportState | null {
  if (view.status === "ready") {
    if (view.downloadUrl) {
      return {
        kind: "ready",
        id: view.id,
        downloadUrl: view.downloadUrl,
      };
    }
    return {
      kind: "error",
      message: "Export marked ready but the download link is missing.",
    };
  }
  if (view.status === "failed" || view.status === "expired") {
    return {
      kind: "error",
      message: view.errorMessage ?? `Export ${view.status}`,
    };
  }
  return null;
}

type DeleteState =
  | { kind: "idle" }
  | { kind: "deleting" }
  | { kind: "error"; message: string };

const EXPORT_CONTENTS = [
  "Rides (GPX tracks and stats)",
  "Saved routes and trip plans",
  "Profile and bike garage",
  "Road segment reviews and photos",
  "Hazard reports you've submitted",
];

export default function DataPage() {
  const user = useAuthStore((s) => s.user);
  const [exportState, setExportState] = useState<ExportState>({ kind: "idle" });
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function requestExport() {
    if (exportState.kind === "requesting" || exportState.kind === "polling")
      return;
    setExportState({ kind: "requesting" });
    try {
      const { data: view } = await accountApi.requestDataExport();
      const next = nextExportState(view);
      if (next) setExportState(next);
      else setExportState({ kind: "polling", id: view.id });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not start export";
      setExportState({ kind: "error", message });
    }
  }

  // Only re-run when entering or leaving the polling state, or when the
  // request id changes — depending on the whole exportState would tear
  // down the timer on any sibling state change.
  const pollingId = exportState.kind === "polling" ? exportState.id : null;
  useEffect(() => {
    if (pollingId === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Tolerate transient polling failures (CDN 502, brief network drops,
    // momentary 401 during token refresh) — the backend job is still
    // alive, so giving up on the first error would strand the user with
    // a misleading "Polling failed" while the bundle is still cooking.
    // Only escalate to error after several consecutive failures.
    const MAX_CONSECUTIVE_ERRORS = 5;
    let consecutiveErrors = 0;
    // Self-rescheduling tick instead of setInterval: at most one
    // request is in flight at a time, so a slow backend can't queue up
    // overlapping polls and out-of-order responses can't regress a
    // newer state into an older one.
    const tick = async () => {
      try {
        const { data: view } = await accountApi.getDataExport(pollingId);
        if (cancelled) return;
        consecutiveErrors = 0;
        const next = nextExportState(view);
        if (next) {
          setExportState(next);
          return;
        }
        timer = setTimeout(() => void tick(), 2000);
      } catch (err) {
        if (cancelled) return;
        consecutiveErrors += 1;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          setExportState({
            kind: "error",
            message: err instanceof Error ? err.message : "Polling failed",
          });
          return;
        }
        timer = setTimeout(() => void tick(), 2000);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [pollingId]);

  return (
    <div className="p-6 max-w-3xl mx-auto animate-fade-in">
      <Link
        href="/settings"
        className="inline-flex items-center gap-1 text-sm text-slate-400 hover:text-white mb-4 transition"
      >
        <ArrowLeft size={16} /> Settings
      </Link>
      <h1 className="text-2xl font-bold mb-2">Data &amp; Account</h1>
      <p className="text-sm text-slate-400 mb-6">
        Export a copy of everything Tarmoto has on you, or delete your account
        permanently. Both actions comply with GDPR Articles 15 and 17.
      </p>

      {/* Export */}
      <section className="rounded-xl bg-slate-900 border border-slate-800 p-5 mb-6">
        <div className="flex items-start gap-3 mb-4">
          <div className="p-2 rounded-lg bg-slate-800 text-tarmoto-cyan">
            <Download size={18} />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-white">
              Download my data
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              We&apos;ll prepare a ZIP archive with everything tied to your
              account. The download link appears here when ready and stays valid
              for 7 days.
            </p>
          </div>
        </div>

        <ul className="text-xs text-slate-400 space-y-1 mb-5 ml-12">
          {EXPORT_CONTENTS.map((item) => (
            <li key={item} className="flex items-center gap-2">
              <Check size={12} className="text-tarmoto-cyan shrink-0" />
              <span>{item}</span>
            </li>
          ))}
        </ul>

        <div className="ml-12 flex items-center gap-3 flex-wrap">
          <button
            type="button"
            onClick={requestExport}
            disabled={
              exportState.kind === "requesting" ||
              exportState.kind === "polling"
            }
            className="px-4 py-2 rounded-lg bg-tarmoto-cyan text-slate-950 font-semibold text-sm hover:bg-tarmoto-cyan-light transition disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
          >
            {exportState.kind === "requesting" ||
            exportState.kind === "polling" ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                {exportState.kind === "requesting"
                  ? "Requesting…"
                  : "Assembling your data…"}
              </>
            ) : (
              <>
                <Download size={14} /> Request export
              </>
            )}
          </button>

          {exportState.kind === "polling" && (
            <span
              role="status"
              className="inline-flex items-center gap-1.5 text-sm text-slate-400"
            >
              Usually takes under a minute.
            </span>
          )}
          {exportState.kind === "ready" && (
            <a
              href={exportState.downloadUrl}
              download
              role="status"
              className="inline-flex items-center gap-1.5 text-sm text-tarmoto-cyan underline hover:text-tarmoto-cyan-light"
            >
              <Download size={14} /> Download your data (link expires in 7 days)
            </a>
          )}
          {exportState.kind === "error" && (
            <span role="alert" className="text-sm text-red-400">
              {exportState.message}
            </span>
          )}
        </div>
      </section>

      {/* Delete account */}
      <section className="rounded-xl border border-red-500/20 bg-red-500/5 p-5">
        <div className="flex items-start gap-3 mb-4">
          <div className="p-2 rounded-lg bg-red-500/10 text-red-400">
            <Trash2 size={18} />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-red-300">
              Delete my account
            </h2>
            <p className="text-xs text-red-200/70 mt-0.5">
              Permanently removes your profile, rides, routes, reviews and
              hazard reports within 30 days. Anonymized road quality
              contributions stay in the community dataset (no personal
              identifiers). This action cannot be undone.
            </p>
          </div>
        </div>

        <div className="ml-12">
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500/10 text-red-300 text-sm font-semibold hover:bg-red-500/20 transition border border-red-500/30"
          >
            <Trash2 size={14} /> Delete my account…
          </button>
        </div>
      </section>

      {confirmOpen && user?.email && (
        <DeleteConfirmModal
          email={user.email}
          onClose={() => setConfirmOpen(false)}
        />
      )}
    </div>
  );
}

interface DeleteConfirmModalProps {
  email: string;
  onClose: () => void;
}

function DeleteConfirmModal({ email, onClose }: DeleteConfirmModalProps) {
  const [typed, setTyped] = useState("");
  const [password, setPassword] = useState("");
  const [state, setState] = useState<DeleteState>({ kind: "idle" });

  const confirmed = isDeletionConfirmed(typed, email);
  const canSubmit = confirmed && password.length > 0;
  const busy = state.kind === "deleting";

  async function confirmDelete() {
    if (!canSubmit || busy) return;
    setState({ kind: "deleting" });
    try {
      await accountApi.deleteAccount({ password });
      // AuthSync clears the Zustand store when next-auth transitions to
      // unauthenticated, so we only need to signOut here. Clearing the store
      // ourselves would unmount this modal (gated on user?.email) mid-await
      // and swallow any signOut error.
      await signOut({ callbackUrl: "/login?deleted=1" });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not delete account";
      setState({ kind: "error", message });
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-account-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-2xl bg-slate-900 border border-red-500/30 shadow-xl">
        <header className="flex items-start justify-between gap-4 p-5 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <AlertTriangle size={18} className="text-red-400" />
            <h3 id="delete-account-title" className="text-sm font-semibold">
              Delete account permanently
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition disabled:opacity-50"
          >
            <X size={16} />
          </button>
        </header>

        <div className="p-5 space-y-4">
          <p className="text-sm text-slate-300">
            This will schedule your account and all associated personal data for
            deletion within 30 days. We&apos;ll email you a confirmation.
          </p>
          <p className="text-sm text-slate-400">
            To confirm, type your email address{" "}
            <span className="font-mono text-white">{email}</span> below.
          </p>
          <div>
            <label
              htmlFor="delete-confirm-email"
              className="block text-xs text-slate-500 mb-1.5"
            >
              Your email address
            </label>
            <input
              id="delete-confirm-email"
              type="email"
              autoComplete="off"
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              disabled={busy}
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:outline-none focus:border-red-400 transition disabled:opacity-50"
            />
          </div>
          <div>
            <label
              htmlFor="delete-confirm-password"
              className="block text-xs text-slate-500 mb-1.5"
            >
              Your password
            </label>
            <input
              id="delete-confirm-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:outline-none focus:border-red-400 transition disabled:opacity-50"
            />
          </div>
          {state.kind === "error" && (
            <p role="alert" className="text-sm text-red-400">
              {state.message}
            </p>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 p-5 border-t border-slate-800">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 text-sm hover:bg-slate-700 transition disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirmDelete}
            disabled={!canSubmit || busy}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500 text-white text-sm font-semibold hover:bg-red-600 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? (
              <>
                <Loader2 size={14} className="animate-spin" /> Deleting…
              </>
            ) : (
              <>
                <Trash2 size={14} /> Delete account
              </>
            )}
          </button>
        </footer>
      </div>
    </div>
  );
}
