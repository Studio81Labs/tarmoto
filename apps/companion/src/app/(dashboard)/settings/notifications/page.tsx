"use client";
import { t } from "@/i18n";
import { useEffect, useState } from "react";
import { Bell, Check, Loader2, Mail, Smartphone } from "lucide-react";
import { accountApi } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { Button, Card, RadioCardGrid, Stamp, Toggle } from "@tarmoto/ui";
import { SettingsSubpageHeader } from "../_SettingsSubpageHeader";
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
  // Wait for the auth store to carry a token before fetching — same
  // hard-navigation race fix as the privacy / subscription / trip detail
  // pages.
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
      <div className="mx-auto w-full max-w-page p-7">
        <div className="flex items-center gap-2 text-fg-dim">
          <Loader2 size={16} className="animate-spin" />
          {t("Loading preferences… ")}
        </div>
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="mx-auto w-full max-w-page animate-fade-in p-7">
        <SettingsSubpageHeader
          stamp={t("Settings · Notifications")}
          icon={<Bell size={18} strokeWidth={2} />}
          title={t("Notifications")}
          sub={t(
            "Email, alerts, community updates — choose which signals reach you and where.",
          )}
        />
        <div className="rounded-xl border border-quality-q1/30 bg-quality-q1/10 p-5 text-sm text-red-400">
          {t("Could not load preferences: ")}
          {loadError}
        </div>
      </div>
    );
  }
  return (
    <div className="mx-auto w-full max-w-page animate-fade-in p-7">
      <SettingsSubpageHeader
        stamp={t("Settings · Notifications")}
        icon={<Bell size={18} strokeWidth={2} />}
        title={t("Notifications")}
        sub={t(
          "Email, alerts, community updates — choose which signals reach you and where.",
        )}
      />

      {/* Email digest */}
      <Card padded={false} className="mb-4 p-[22px]">
        <div className="mb-4">
          <Stamp as="h2" className="mb-1 block">
            {t("Email digest")}
          </Stamp>
          <p className="text-[12px] text-fg-dim">
            {t("Summary of your riding stats and community activity. ")}
          </p>
        </div>
        <RadioCardGrid
          ariaLabel={t("Email digest frequency")}
          className="grid grid-cols-3 gap-2"
          value={prefs.email_digest}
          onChange={setDigest}
          options={EMAIL_DIGEST_OPTIONS}
        />
      </Card>

      {/* Per-category toggles */}
      <Card padded={false} className="mb-4 divide-y divide-line">
        <div className="flex items-center px-5 py-3">
          <Stamp className="flex-1">{t("Notification ")}</Stamp>
          <div className="flex items-center gap-6">
            <Stamp className="flex w-10 items-center justify-center gap-1">
              <Mail size={12} />
              {t("Email ")}
            </Stamp>
            <Stamp className="flex w-10 items-center justify-center gap-1">
              <Smartphone size={12} />
              {t("Push ")}
            </Stamp>
          </div>
        </div>
        {VISIBLE_NOTIFICATION_CATEGORIES.map((category) => {
          const meta = VISIBLE_CATEGORY_LABELS[category];
          const toggles = prefs.categories[category];
          return (
            <div key={category} className="flex items-center gap-4 px-5 py-4">
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-semibold text-ink">
                  {meta.label}
                </p>
                <p className="mt-0.5 text-[12px] text-fg-dim">
                  {meta.description}
                </p>
              </div>
              <div className="flex items-center gap-6">
                <Toggle
                  checked={toggles.email}
                  onChange={() => toggleChannel(category, "email")}
                  ariaLabel={`${meta.label} email`}
                />
                <Toggle
                  checked={toggles.push}
                  onChange={() => toggleChannel(category, "push")}
                  ariaLabel={`${meta.label} push`}
                />
              </div>
            </div>
          );
        })}
      </Card>

      {/* Marketing opt-in */}
      <Card padded={false} className="mb-6 p-[22px]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[14px] font-semibold text-ink">
              {t("Marketing emails")}
            </p>
            <p className="mt-0.5 text-[12px] text-fg-dim">
              {t(
                "Product launches, deals with partners, seasonal riding guides. Opt-in only — off by default. ",
              )}
            </p>
          </div>
          <Toggle
            checked={prefs.marketing_emails}
            onChange={toggleMarketing}
            ariaLabel="Marketing emails"
          />
        </div>
      </Card>

      <SaveBar isDirty={isDirty} saveState={saveState} onSave={save} />
    </div>
  );
}

interface SaveBarProps {
  isDirty: boolean;
  saveState: SaveState;
  onSave: () => void;
}
function SaveBar({ isDirty, saveState, onSave }: SaveBarProps) {
  return (
    <div className="flex items-center gap-3">
      <Button
        variant="accent"
        uppercase
        disabled={!isDirty}
        loading={saveState.kind === "saving"}
        onClick={onSave}
      >
        {saveState.kind === "saving" ? t("Saving… ") : t("Save preferences")}
      </Button>
      {saveState.kind === "saved" && !isDirty && (
        <span className="inline-flex items-center gap-1 text-[13px] text-accent">
          <Check size={14} />
          {t("Saved ")}
        </span>
      )}
      {saveState.kind === "error" && (
        <span className="text-[13px] text-red-400">{saveState.message}</span>
      )}
      {isDirty && saveState.kind !== "saving" && (
        <span className="text-[13px] text-fg-mute">{t("Unsaved changes")}</span>
      )}
    </div>
  );
}
