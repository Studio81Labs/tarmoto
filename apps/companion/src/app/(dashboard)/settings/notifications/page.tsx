"use client";
import { t } from "@/i18n";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Loader2, Mail, Smartphone } from "lucide-react";
import { accountApi } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { Stamp } from "@/components/tarmoto/atoms";
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
  | {
      kind: "idle";
    }
  | {
      kind: "saving";
    }
  | {
      kind: "saved";
    }
  | {
      kind: "error";
      message: string;
    };
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
  // Wait for the auth store to carry a token before fetching — same
  // hard-navigation race fix as the privacy / subscription / trip
  // detail pages.
  const authReady = useAuthStore((s) => Boolean(s.accessToken));
  useEffect(() => {
    if (!authReady) return;
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
  }, [authReady]);
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
      <div className="p-6 max-w-page-narrow mx-auto">
        <div className="flex items-center gap-2 text-fg-dim">
          <Loader2 size={16} className="animate-spin" />
          {t("Loading preferences\u2026 ")}
        </div>
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="p-6 max-w-page-narrow mx-auto animate-fade-in">
        <Link
          href="/settings"
          className="inline-flex items-center gap-1 text-sm text-fg-dim hover:text-ink mb-4 transition"
        >
          <ArrowLeft size={16} />
          {t("Settings ")}
        </Link>
        <Stamp className="block mb-2">{t("Notifications")}</Stamp>
        <h1 className="font-sans font-extrabold tracking-[-0.5px] leading-[1.05] text-[32px] text-ink mb-6">
          {t("Notifications")}
        </h1>
        <div className="rounded-xl border border-quality-q1/30 bg-quality-q1/10 p-5 text-sm text-red-400">
          {t("Could not load preferences: ")}
          {loadError}
        </div>
      </div>
    );
  }
  return (
    <div className="p-6 max-w-page-narrow mx-auto animate-fade-in">
      <Link
        href="/settings"
        className="inline-flex items-center gap-1 text-sm text-fg-dim hover:text-ink mb-4 transition"
      >
        <ArrowLeft size={16} />
        {t("Settings ")}
      </Link>
      <Stamp className="block mb-2">{t("Notifications")}</Stamp>
      <h1 className="font-sans font-extrabold tracking-[-0.5px] leading-[1.05] text-[32px] text-ink mb-3">
        {t("Notifications")}
      </h1>
      <p className="text-sm text-fg-dim mb-6">
        {t(
          "Choose which updates you want, and where you want them. Email goes to your account address; push goes to the mobile app. ",
        )}
      </p>

      {/* Email digest */}
      <section className="rounded-2xl bg-cream border border-line p-[22px] mb-6">
        <div className="mb-4">
          <Stamp as="h2" className="block mb-1">
            {t("Email digest")}
          </Stamp>
          <p className="text-xs text-fg-dim">
            {t("Summary of your riding stats and community activity. ")}
          </p>
        </div>
        <div
          role="radiogroup"
          aria-label={t("Email digest frequency")}
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
                    ? "border-ink bg-ink text-cream"
                    : "border-line bg-paper text-ink hover:border-line-strong"
                }`}
              >
                <span className="text-sm font-semibold">{opt.label}</span>
                <span
                  className={`text-xs ${active ? "text-fg-on-dark-dim" : "text-fg-dim"}`}
                >
                  {opt.description}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Per-category toggles */}
      <section className="rounded-2xl bg-cream border border-line divide-y divide-line mb-6">
        <div className="px-5 py-3 flex items-center">
          <Stamp className="flex-1">{t("Notification ")}</Stamp>
          <div className="flex items-center gap-6">
            <Stamp className="flex items-center gap-1 w-10 justify-center">
              <Mail size={12} />
              {t("Email ")}
            </Stamp>
            <Stamp className="flex items-center gap-1 w-10 justify-center">
              <Smartphone size={12} />
              {t("Push ")}
            </Stamp>
          </div>
        </div>
        {VISIBLE_NOTIFICATION_CATEGORIES.map((category) => {
          const meta = VISIBLE_CATEGORY_LABELS[category];
          const toggles = prefs.categories[category];
          return (
            <div key={category} className="px-5 py-4 flex items-center gap-4">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-ink">{meta.label}</p>
                <p className="text-xs text-fg-dim mt-0.5">{meta.description}</p>
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
      <section className="rounded-2xl bg-cream border border-line p-[22px] mb-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-ink">
              {t("Marketing emails")}
            </p>
            <p className="text-xs text-fg-dim mt-0.5">
              {t(
                "Product launches, deals with partners, seasonal riding guides. Opt-in only \u2014 off by default. ",
              )}
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
          className="px-4 py-2 rounded-full bg-accent text-ink font-bold text-sm tracking-[0.2px] hover:brightness-95 transition disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
        >
          {saveState.kind === "saving" ? (
            <>
              <Loader2 size={14} className="animate-spin" />
              {t("Saving\u2026 ")}
            </>
          ) : (
            "Save preferences"
          )}
        </button>

        {saveState.kind === "saved" && !isDirty && (
          <span className="inline-flex items-center gap-1 text-sm text-accent">
            <Check size={14} />
            {t("Saved ")}
          </span>
        )}
        {saveState.kind === "error" && (
          <span className="text-sm text-red-400">{saveState.message}</span>
        )}
        {isDirty && saveState.kind !== "saving" && (
          <span className="text-sm text-fg-mute">{t("Unsaved changes")}</span>
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
      className={`relative w-9 h-5 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-accent/40 ${enabled ? "bg-ink" : "bg-ink/12"}`}
    >
      <span
        className={`absolute top-0.5 w-4 h-4 rounded-full transform transition-transform ${enabled ? "bg-accent left-0.5 translate-x-4" : "bg-cream left-0.5"}`}
      />
    </button>
  );
}
