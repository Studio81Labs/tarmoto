"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Loader2, Mail, Smartphone } from "lucide-react";
import { accountApi } from "@/lib/api";
import type {
  EmailDigestFrequency,
  NotificationChannels,
  NotificationPreferences,
} from "@/lib/types";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  EMAIL_DIGEST_OPTIONS,
  mergeWithDefaults,
  preferencesEqual,
  type PartialNotificationPreferences,
  type PerChannelKey,
} from "@/lib/notification-preferences";

const CHANNEL_SECTIONS: {
  key: PerChannelKey;
  label: string;
  description: string;
}[] = [
  {
    key: "hazardAlertsSavedRoutes",
    label: "Hazard alerts for saved routes",
    description:
      "Get warned about new potholes, roadworks, or hazards reported on routes you ride.",
  },
  {
    key: "tripCollaboration",
    label: "Trip collaboration",
    description: "Invites, edits, and comments on trips you collaborate on.",
  },
  {
    key: "newFollowers",
    label: "New followers",
    description: "When another rider follows your profile.",
  },
  {
    key: "routeComments",
    label: "Route comments",
    description: "Comments on your shared routes and rides.",
  },
  {
    key: "rideLikes",
    label: "Ride likes",
    description: "When riders like one of your shared rides.",
  },
];

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

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

  function setDigest(value: EmailDigestFrequency) {
    setPrefs((p) => ({ ...p, emailDigest: value }));
    setSaveState({ kind: "idle" });
  }

  function toggleChannel(
    key: PerChannelKey,
    channel: keyof NotificationChannels,
  ) {
    setPrefs((p) => ({
      ...p,
      [key]: { ...p[key], [channel]: !p[key][channel] },
    }));
    setSaveState({ kind: "idle" });
  }

  function toggleMarketing() {
    setPrefs((p) => ({ ...p, marketingEmails: !p.marketingEmails }));
    setSaveState({ kind: "idle" });
  }

  async function save() {
    setSaveState({ kind: "saving" });
    try {
      await accountApi.updateNotificationPreferences(prefs);
      setServerPrefs(prefs);
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
            const active = prefs.emailDigest === opt.value;
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

      {/* Per-channel toggles */}
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
        {CHANNEL_SECTIONS.map((section) => (
          <div key={section.key} className="px-5 py-4 flex items-center gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white">{section.label}</p>
              <p className="text-xs text-slate-500 mt-0.5">
                {section.description}
              </p>
            </div>
            <div className="flex items-center gap-6">
              <ChannelToggle
                label={`${section.label} email`}
                enabled={prefs[section.key].email}
                onToggle={() => toggleChannel(section.key, "email")}
              />
              <ChannelToggle
                label={`${section.label} push`}
                enabled={prefs[section.key].push}
                onToggle={() => toggleChannel(section.key, "push")}
              />
            </div>
          </div>
        ))}
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
            enabled={prefs.marketingEmails}
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
