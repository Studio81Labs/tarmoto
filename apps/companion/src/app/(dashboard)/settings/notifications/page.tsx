"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Loader2, Mail, Smartphone } from "lucide-react";
import { accountApi } from "@/lib/api";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  EMAIL_DIGEST_OPTIONS,
  VISIBLE_CATEGORY_LABELS,
  VISIBLE_NOTIFICATION_CATEGORIES,
  mergeWithDefaults,
  preferencesEqual,
  type EmailDigestFrequency,
  type NotificationChannelToggles,
  type NotificationPreferences,
  type PartialNotificationPreferences,
  type VisibleNotificationCategory,
} from "@/lib/notification-preferences";

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

type CategoryChannel = Extract<
  keyof NotificationChannelToggles,
  "email" | "push"
>;

export default function NotificationsPage() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [serverPrefs, setServerPrefs] = useState<NotificationPreferences>(
    DEFAULT_NOTIFICATION_PREFERENCES,
  );
  const [prefs, setPrefs] = useState<NotificationPreferences>(
    DEFAULT_NOTIFICATION_PREFERENCES,
  );
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    accountApi
      .getNotificationPreferences()
      .then(({ data }) => {
        if (cancelled) return;
        const merged = mergeWithDefaults(
          data as PartialNotificationPreferences | null,
        );
        setServerPrefs(merged);
        setPrefs(merged);
        setLoading(false);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setLoadError(err.message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const isDirty = !preferencesEqual(prefs, serverPrefs);

  // Clear a prior "saved"/"error" badge once the user starts editing, but
  // never overwrite an in-flight "saving" state — doing so would re-enable
  // the save button and allow a second concurrent save to race the first.
  function clearTransientSaveState() {
    setSaveState((s) => (s.kind === "saving" ? s : { kind: "idle" }));
  }

  function setDigest(value: EmailDigestFrequency) {
    setPrefs((p) => ({ ...p, email_digest: value }));
    clearTransientSaveState();
  }

  function toggleChannel(
    category: VisibleNotificationCategory,
    channel: CategoryChannel,
  ) {
    setPrefs((p) => ({
      ...p,
      categories: {
        ...p.categories,
        [category]: {
          ...p.categories[category],
          [channel]: !p.categories[category][channel],
        },
      },
    }));
    clearTransientSaveState();
  }

  function toggleMarketing() {
    setPrefs((p) => ({ ...p, marketing_emails: !p.marketing_emails }));
    clearTransientSaveState();
  }

  async function save() {
    if (saveState.kind === "saving") return;
    setSaveState({ kind: "saving" });
    try {
      const { data } = await accountApi.updateNotificationPreferences({
        email_digest: prefs.email_digest,
        marketing_emails: prefs.marketing_emails,
        categories: prefs.categories,
      });
      const merged = mergeWithDefaults(
        data as PartialNotificationPreferences | null,
      );
      setServerPrefs(merged);
      setPrefs(merged);
      setSaveState({ kind: "saved" });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not save preferences";
      setSaveState({ kind: "error", message });
    }
  }

  if (loading) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="flex items-center gap-2 text-slate-400">
          <Loader2 size={16} className="animate-spin" /> Loading preferences…
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="p-6 max-w-3xl mx-auto animate-fade-in">
        <Link
          href="/settings"
          className="inline-flex items-center gap-1 text-sm text-slate-400 hover:text-white mb-4 transition"
        >
          <ArrowLeft size={16} /> Settings
        </Link>
        <h1 className="text-2xl font-bold mb-6">Notifications</h1>
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-5 text-sm text-red-300">
          Could not load preferences: {loadError}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl mx-auto animate-fade-in">
      <Link
        href="/settings"
        className="inline-flex items-center gap-1 text-sm text-slate-400 hover:text-white mb-4 transition"
      >
        <ArrowLeft size={16} /> Settings
      </Link>
      <h1 className="text-2xl font-bold mb-2">Notifications</h1>
      <p className="text-sm text-slate-400 mb-6">
        Choose which updates you want, and where you want them. Email goes to
        your account address; push goes to the mobile app.
      </p>

      {/* Email digest */}
      <section className="rounded-xl bg-slate-900 border border-slate-800 p-5 mb-6">
        <div className="mb-4">
          <h2 className="text-sm font-semibold text-white">Email digest</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Summary of your riding stats and community activity.
          </p>
        </div>
        <div
          role="radiogroup"
          aria-label="Email digest frequency"
          className="grid grid-cols-3 gap-2"
        >
          {EMAIL_DIGEST_OPTIONS.map((opt) => {
            const active = prefs.email_digest === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setDigest(opt.value)}
                className={`flex flex-col items-start gap-0.5 px-3 py-2.5 rounded-lg border text-left transition ${
                  active
                    ? "border-tarmoto-cyan bg-tarmoto-cyan/10 text-white"
                    : "border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-600"
                }`}
              >
                <span className="text-sm font-medium">{opt.label}</span>
                <span className="text-xs text-slate-500">
                  {opt.description}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Per-category toggles */}
      <section className="rounded-xl bg-slate-900 border border-slate-800 divide-y divide-slate-800 mb-6">
        <div className="px-5 py-3 flex items-center">
          <div className="flex-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
            Notification
          </div>
          <div className="flex items-center gap-6 text-xs font-semibold uppercase tracking-wider text-slate-500">
            <span className="flex items-center gap-1 w-10 justify-center">
              <Mail size={12} /> Email
            </span>
            <span className="flex items-center gap-1 w-10 justify-center">
              <Smartphone size={12} /> Push
            </span>
          </div>
        </div>
        {VISIBLE_NOTIFICATION_CATEGORIES.map((category) => {
          const meta = VISIBLE_CATEGORY_LABELS[category];
          const toggles = prefs.categories[category];
          return (
            <div key={category} className="px-5 py-4 flex items-center gap-4">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-white">{meta.label}</p>
                <p className="text-xs text-slate-500 mt-0.5">
                  {meta.description}
                </p>
              </div>
              <div className="flex items-center gap-6">
                <ChannelToggle
                  label={`${meta.label} email`}
                  enabled={toggles.email}
                  onToggle={() => toggleChannel(category, "email")}
                />
                <ChannelToggle
                  label={`${meta.label} push`}
                  enabled={toggles.push}
                  onToggle={() => toggleChannel(category, "push")}
                />
              </div>
            </div>
          );
        })}
      </section>

      {/* Marketing opt-in */}
      <section className="rounded-xl bg-slate-900 border border-slate-800 p-5 mb-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-white">Marketing emails</p>
            <p className="text-xs text-slate-500 mt-0.5">
              Product launches, deals with partners, seasonal riding guides.
              Opt-in only — off by default.
            </p>
          </div>
          <ChannelToggle
            label="Marketing emails"
            enabled={prefs.marketing_emails}
            onToggle={toggleMarketing}
          />
        </div>
      </section>

      {/* Save bar */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={!isDirty || saveState.kind === "saving"}
          className="px-4 py-2 rounded-lg bg-tarmoto-cyan text-slate-950 font-semibold text-sm hover:bg-tarmoto-cyan-light transition disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
        >
          {saveState.kind === "saving" ? (
            <>
              <Loader2 size={14} className="animate-spin" /> Saving…
            </>
          ) : (
            "Save preferences"
          )}
        </button>

        {saveState.kind === "saved" && !isDirty && (
          <span className="inline-flex items-center gap-1 text-sm text-tarmoto-cyan">
            <Check size={14} /> Saved
          </span>
        )}
        {saveState.kind === "error" && (
          <span className="text-sm text-red-400">{saveState.message}</span>
        )}
        {isDirty && saveState.kind !== "saving" && (
          <span className="text-sm text-slate-500">Unsaved changes</span>
        )}
      </div>
    </div>
  );
}

interface ChannelToggleProps {
  enabled: boolean;
  onToggle: () => void;
  label: string;
}

function ChannelToggle({ enabled, onToggle, label }: ChannelToggleProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={enabled}
      aria-label={label}
      className={`relative w-10 h-6 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-tarmoto-cyan/30 ${
        enabled ? "bg-tarmoto-cyan" : "bg-slate-700"
      }`}
    >
      <span
        className={`absolute left-0.5 top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transform transition-transform ${
          enabled ? "translate-x-4" : "translate-x-0"
        }`}
      />
    </button>
  );
}
