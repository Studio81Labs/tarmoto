"use client";

import { useTranslation } from "@/i18n/I18nProvider";
import { getUserFacingErrorMessage, type Translate } from "@/i18n";
import { useEffect, useState } from "react";
import { signOut } from "next-auth/react";
import {
  AlertTriangle,
  Check,
  Database,
  Download,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";
import { accountApi } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { isDeletionConfirmed } from "@/lib/account-deletion";
import {
  normalizeSubscriptionSnapshot,
  type SubscriptionSnapshot,
} from "@/lib/subscription";
import {
  Button,
  Card,
  FieldLabel,
  Input,
  PasswordInput,
  Stamp,
} from "@tarmoto/ui";
import { SettingsSubpageHeader } from "../_SettingsSubpageHeader";
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
function nextExportState(view: ExportView, t: Translate): ExportState | null {
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
      message: t("Export marked ready but the download link is missing."),
    };
  }
  if (view.status === "failed") {
    return {
      kind: "error",
      message: t("Export failed. Please try again."),
    };
  }
  if (view.status === "expired") {
    return {
      kind: "error",
      message: t("Export expired. Request a new archive."),
    };
  }
  return null;
}
type DeleteState =
  | { kind: "idle" }
  | { kind: "deleting" }
  | { kind: "error"; message: string };
// Provider-specific consequence the rider needs to know BEFORE the
// mutating delete, not after. `DELETE /account` soft-deletes and starts
// the renewal-stop path immediately, so a warning shown only post-hoc
// would already be too late — this is why the confirm dialog preflights
// `GET /account/subscription` instead of waiting for the delete response.
type SubscriptionWarningKind = "stripe" | "app_store" | "play_store";
// `null` covers both a free/no-subscription account and a failed or
// preview-only preflight lookup — every one of those falls back to the
// existing generic deletion copy rather than blocking the flow.
type SubscriptionPreflightState =
  | { kind: "loading" }
  | { kind: "resolved"; warning: SubscriptionWarningKind | null };

function subscriptionWarningKind(
  snapshot: SubscriptionSnapshot,
): SubscriptionWarningKind | null {
  // Store-managed ownership survives a temporary tier drop (Google Play
  // hold/pause, Apple billing retry) — the store still owns the slot and
  // the rider still needs to cancel there, so this check is keyed on
  // `managedBy` alone and must run before the tier/preview short-circuit
  // below (which only applies to the Stripe restoration warning).
  if (snapshot.managedBy === "app_store") return "app_store";
  if (snapshot.managedBy === "play_store") return "play_store";
  if (snapshot.preview || snapshot.currentPlan.tier === "free") return null;
  return "stripe";
}

function useSubscriptionDeletionPreflight(
  t: Translate,
): SubscriptionPreflightState {
  const [state, setState] = useState<SubscriptionPreflightState>({
    kind: "loading",
  });
  useEffect(() => {
    let cancelled = false;
    accountApi
      .getSubscription()
      .then(({ data }) => {
        if (cancelled) return;
        const snapshot = normalizeSubscriptionSnapshot(data, t);
        setState({
          kind: "resolved",
          warning: subscriptionWarningKind(snapshot),
        });
      })
      .catch(() => {
        // Advisory only — a failed preflight (no billing configured, a
        // transient network error, etc.) must not block deletion. Fall
        // back to the generic copy rather than surfacing an error here.
        if (!cancelled) setState({ kind: "resolved", warning: null });
      });
    return () => {
      cancelled = true;
    };
  }, [t]);
  return state;
}
const EXPORT_CONTENTS = [
  "Rides (GPX tracks and stats)",
  "Saved routes and trip plans",
  "Profile and bike garage",
  "Road segment reviews and photos",
  "Hazard reports you've submitted",
];
export default function DataPage() {
  const t = useTranslation();
  const user = useAuthStore((s) => s.user);
  // Gate the export button on `AuthSync` hydrating the access
  // token. The data page is reachable on a hard navigation
  // (deep-linked, browser back from /settings, etc.) where the
  // in-memory Zustand store starts empty; without this gate, the
  // first click races AuthSync and `accountApi.requestDataExport`
  // ships without a bearer → 401 → "Could not start export"
  // error toast. Same fix as `/rides/[rideId]`.
  const accessToken = useAuthStore((s) => s.accessToken);
  const [exportState, setExportState] = useState<ExportState>({ kind: "idle" });
  const [confirmOpen, setConfirmOpen] = useState(false);
  async function requestExport() {
    if (exportState.kind === "requesting" || exportState.kind === "polling")
      return;
    if (!accessToken) return;
    setExportState({ kind: "requesting" });
    try {
      const { data: view } = await accountApi.requestDataExport();
      const next = nextExportState(view, t);
      if (next) setExportState(next);
      else setExportState({ kind: "polling", id: view.id });
    } catch (err) {
      const message = getUserFacingErrorMessage(
        err,
        t("Could not start export"),
      );
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
    // Hard client-side cap on how long we'll wait for a terminal
    // status. Real exports complete in seconds; if we're still polling
    // after 10 min the worker is almost certainly dead in a way the
    // backend hasn't yet reflected on the row (and the server's
    // stuck-row threshold is 30 min, so this fires first). Without
    // this, a worker that died AND failed to record its own failure
    // would have us polling for 7 days until the TTL expired.
    const MAX_POLL_MS = 10 * 60 * 1000;
    const startedAt = Date.now();
    let consecutiveErrors = 0;
    // Self-rescheduling tick instead of setInterval: at most one
    // request is in flight at a time, so a slow backend can't queue up
    // overlapping polls and out-of-order responses can't regress a
    // newer state into an older one.
    const tick = async () => {
      if (Date.now() - startedAt > MAX_POLL_MS) {
        setExportState({
          kind: "error",
          message: t(
            "Export is taking longer than expected. Please try again in a few minutes.",
          ),
        });
        return;
      }
      try {
        const { data: view } = await accountApi.getDataExport(pollingId);
        if (cancelled) return;
        consecutiveErrors = 0;
        const next = nextExportState(view, t);
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
            message: getUserFacingErrorMessage(
              err,
              t("Could not check export progress."),
            ),
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
  }, [t, pollingId]);
  return (
    <div className="mx-auto w-full max-w-page animate-fade-in p-4 md:p-7">
      <SettingsSubpageHeader
        stamp={t("Settings · Data")}
        icon={<Database size={18} strokeWidth={2} />}
        title={t("Data & Account")}
        sub={t(
          "Export your data or delete your account. Tarmoto follows GDPR — your data is yours.",
        )}
      />

      {/* Export */}
      <Card padded={false} className="mb-4 p-[22px]">
        <div className="mb-4 flex items-start gap-3">
          <div className="rounded-lg bg-paper p-2 text-accent">
            <Download size={18} />
          </div>
          <div>
            <Stamp as="h2" className="mb-1 block">
              {t("Download my data")}
            </Stamp>
            <p className="mt-0.5 text-[12px] text-fg-dim">
              {t(
                "We'll prepare a ZIP archive with everything tied to your account. The download link appears here when ready and stays valid for {count, plural, one {# day} other {# days}}.",
                { count: 7 },
              )}
            </p>
          </div>
        </div>

        <ul className="mb-5 ml-12 space-y-1 text-[12px] text-fg-dim">
          {EXPORT_CONTENTS.map((item) => (
            <li key={item} className="flex items-center gap-2">
              <Check size={12} className="shrink-0 text-accent" />
              <span>{item}</span>
            </li>
          ))}
        </ul>

        <div className="ml-12 flex flex-wrap items-center gap-3">
          <Button
            variant="accent"
            uppercase
            disabled={!accessToken}
            loading={
              exportState.kind === "requesting" ||
              exportState.kind === "polling"
            }
            leftIcon={<Download size={14} />}
            onClick={requestExport}
          >
            {exportState.kind === "requesting"
              ? t("Requesting…")
              : exportState.kind === "polling"
                ? t("Assembling your data…")
                : t("Request export")}
          </Button>

          {exportState.kind === "polling" && (
            <span
              role="status"
              className="inline-flex items-center gap-1.5 text-[13px] text-fg-dim"
            >
              {t("Usually takes under a minute.")}
            </span>
          )}
          {exportState.kind === "ready" && (
            <a
              href={exportState.downloadUrl}
              download
              role="status"
              className="inline-flex items-center gap-1.5 text-[13px] text-accent underline hover:brightness-95"
            >
              <Download size={14} />
              {t(
                "Download your data (link expires in {count, plural, one {# day} other {# days}})",
                { count: 7 },
              )}
            </a>
          )}
          {exportState.kind === "error" && (
            <span role="alert" className="text-[13px] text-red-700">
              {exportState.message}
            </span>
          )}
        </div>
      </Card>

      {/* Danger zone */}
      <Card
        padded={false}
        className="border-quality-q1/40 bg-quality-q1/10 p-[22px]"
      >
        <div className="mb-4 flex items-start gap-3">
          <div className="rounded-lg bg-quality-q1/15 p-2 text-quality-q1">
            <Trash2 size={18} />
          </div>
          <div>
            <Stamp as="h2" className="mb-1 block text-quality-q1">
              {t("Danger zone")}
            </Stamp>
            <p className="mt-0.5 max-w-[520px] text-[12px] leading-[1.5] text-quality-q1/80">
              {t(
                "Permanently removes your profile, rides, routes, reviews and hazard reports within {count, plural, one {# day} other {# days}}. Anonymized road quality contributions stay in the community dataset (no personal identifiers). This action cannot be undone.",
                { count: 30 },
              )}
            </p>
          </div>
        </div>

        <div className="ml-12">
          <Button
            variant="danger"
            uppercase
            leftIcon={<Trash2 size={14} />}
            onClick={() => setConfirmOpen(true)}
          >
            {t("Delete my account…")}
          </Button>
        </div>
      </Card>

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
  const t = useTranslation();
  const [typed, setTyped] = useState("");
  const [password, setPassword] = useState("");
  const [state, setState] = useState<DeleteState>({ kind: "idle" });
  const preflight = useSubscriptionDeletionPreflight(t);
  const confirmed = isDeletionConfirmed(typed, email);
  // Block submit until the preflight settles (loaded OR failed-fallback)
  // so a provider-specific warning has a chance to paint before the
  // rider can fire the mutating delete. A resolved-but-errored preflight
  // still allows submit — see the catch in the hook above.
  const canSubmit =
    confirmed && password.length > 0 && preflight.kind !== "loading";
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
      const message = getUserFacingErrorMessage(
        err,
        t("Could not delete account"),
      );
      setState({ kind: "error", message });
    }
  }
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-account-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-2xl border border-quality-q1/40 bg-cream shadow-[0_24px_60px_rgba(14,14,16,0.2)]">
        <header className="flex items-start justify-between gap-4 border-b border-line p-5">
          <div className="flex items-center gap-2">
            <AlertTriangle size={18} className="text-red-700" />
            <h3
              id="delete-account-title"
              className="font-sans text-[18px] font-extrabold tracking-[-0.5px] text-ink"
            >
              {t("Delete account permanently")}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label={t("Close")}
            className="rounded-lg p-1 text-fg-dim transition hover:bg-paper hover:text-ink disabled:opacity-50"
          >
            <X size={16} />
          </button>
        </header>

        <div className="space-y-4 p-5">
          <p className="text-[14px] text-ink">
            {t(
              "This will schedule your account and all associated personal data for deletion within {count, plural, one {# day} other {# days}}. We'll email you a confirmation.",
              { count: 30 },
            )}
          </p>
          {preflight.kind === "resolved" && preflight.warning ? (
            <div className="flex items-start gap-2 rounded-xl border border-quality-q2/40 bg-quality-q2/15 p-3">
              <ShieldAlert
                size={16}
                className="mt-0.5 shrink-0 text-amber-700"
              />
              <p className="text-[13px] text-ink">
                {preflight.warning === "stripe"
                  ? t(
                      "Your paid Stripe subscription will stop renewing when your account is deleted. If you restore after your current billing period ends, we can't reinstate it — you'll need to subscribe again.",
                    )
                  : preflight.warning === "app_store"
                    ? t(
                        "Your subscription is managed by the App Store. Deleting your account does not cancel it — you must cancel it yourself in the App Store to stop future charges.",
                      )
                    : t(
                        "Your subscription is managed by Google Play. Deleting your account does not cancel it, and we can't reactivate it if you restore — cancel or manage it directly in Google Play.",
                      )}
              </p>
            </div>
          ) : null}
          <p className="text-[14px] text-fg-dim">
            {t("To confirm, type your email address {email} below.", {
              email,
            })}
          </p>
          <div>
            <FieldLabel htmlFor="delete-confirm-email">
              {t("Your email address")}
            </FieldLabel>
            <Input
              id="delete-confirm-email"
              type="email"
              autoComplete="off"
              autoFocus
              value={typed}
              onChange={setTyped}
              disabled={busy}
            />
          </div>
          <div>
            <FieldLabel htmlFor="delete-confirm-password">
              {t("Your password")}
            </FieldLabel>
            <PasswordInput
              id="delete-confirm-password"
              value={password}
              onChange={setPassword}
              disabled={busy}
            />
          </div>
          {state.kind === "error" && (
            <p role="alert" className="text-[14px] text-red-700">
              {state.message}
            </p>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-line p-5">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button
            variant="danger-solid"
            size="sm"
            uppercase
            disabled={!canSubmit}
            loading={busy}
            leftIcon={<Trash2 size={14} />}
            onClick={confirmDelete}
          >
            {busy ? t("Deleting…") : t("Delete account")}
          </Button>
        </footer>
      </div>
    </div>
  );
}
