"use client";

import { useTranslation } from "@/i18n/I18nProvider";
import { getUserFacingErrorMessage } from "@/i18n";
import { useEffect, useRef, useState } from "react";
import { Bell, Check, Mail, Smartphone } from "lucide-react";
import { accountApi } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import {
  Button,
  Card,
  RadioCardGrid,
  SkeletonForm,
  SkeletonPageHeader,
  Stamp,
  Toggle,
} from "@tarmoto/ui";
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
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
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
  const t = useTranslation();
  const [loading, setLoading] = useState(true);
  // Debounced: fast loads render content directly, no spinner flash.
  const showLoader = useDelayedLoading(loading);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [serverPrefs, setServerPrefs] = useState<NotificationPreferences>(
    DEFAULT_NOTIFICATION_PREFERENCES,
  );
  const [prefs, setPrefs] = useState<NotificationPreferences>(
    DEFAULT_NOTIFICATION_PREFERENCES,
  );
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  // In-flight on-load timezone sync (see the load effect). save() awaits it so
  // the two full-row writes to notification_preferences never overlap.
  const tzSyncRef = useRef<Promise<void> | null>(null);
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
        // Capture the rider's IANA timezone on first view. `save()` is gated on
        // isDirty (the SaveBar disables when nothing else changed), so a default
        // weekly rider who never toggles another preference would otherwise stay
        // pinned to the backend's UTC default and get their digest sent/bucketed
        // at 08:00 UTC instead of local time. Persist it in the background — only
        // when it actually differs — so timezone-aware delivery works without a
        // manual save.
        const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (browserTz && browserTz !== merged.quiet_hours_timezone) {
          // Serialize this against the explicit save(): the backend update is a
          // full-row read-modify-write, so a timezone-only request that lands
          // AFTER the user's save would restore the stale email_digest/categories
          // it read first. Storing the promise lets save() await it, so the two
          // writes never overlap (and can't both race first-row creation). The
          // trailing .catch keeps the awaited promise from ever rejecting.
          tzSyncRef.current = accountApi
            .updateNotificationPreferences({ quiet_hours_timezone: browserTz })
            .then(() => {
              if (cancelled) return;
              // Sync the saved baseline + editable copy so this background write
              // isn't seen as a spurious unsaved change (preferencesEqual
              // compares quiet_hours_timezone); any in-flight user edits to other
              // fields are preserved.
              setServerPrefs((sp) => ({
                ...sp,
                quiet_hours_timezone: browserTz,
              }));
              setPrefs((p) => ({ ...p, quiet_hours_timezone: browserTz }));
            })
            .catch((err: Error) => {
              // Best-effort background sync — surface in the console, never
              // disrupt the settings page or block the rider.
              console.warn("Timezone sync failed:", err.message);
            });
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(
          getUserFacingErrorMessage(err, t("Could not load preferences")),
        );
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t, authReady]);
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
      // Let any in-flight on-load timezone sync land first — both are full-row
      // writes on the same row, and a tz request completing after this save would
      // restore the pre-save email_digest/categories. (The ref promise never
      // rejects, so this await is safe even if the sync failed.)
      if (tzSyncRef.current) await tzSyncRef.current;
      const { data } = await accountApi.updateNotificationPreferences({
        email_digest: prefs.email_digest,
        marketing_emails: prefs.marketing_emails,
        categories: prefs.categories,
        // Persist the rider's IANA timezone so timezone-aware delivery — the
        // weekly digest's local Sunday-08:00 send + quiet hours — uses their
        // actual zone instead of the server default (UTC). Without a written
        // value the backend has no rider timezone to read. It validates this
        // against pg_timezone_names and falls back to UTC for anything unknown.
        quiet_hours_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      const merged = mergeWithDefaults(
        data as PartialNotificationPreferences | null,
      );
      setServerPrefs(merged);
      setPrefs(merged);
      setSaveState({ kind: "saved" });
    } catch (err) {
      const message = getUserFacingErrorMessage(
        err,
        t("Could not save preferences"),
      );
      setSaveState({ kind: "error", message });
    }
  }
  if (loading) {
    return (
      <div className="mx-auto w-full max-w-page p-4 md:p-7">
        {showLoader && (
          <>
            <SkeletonPageHeader />
            <SkeletonForm sections={3} label={t("Loading preferences…")} />
          </>
        )}
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="mx-auto w-full max-w-page animate-fade-in p-4 md:p-7">
        <SettingsSubpageHeader
          stamp={t("Settings · Notifications")}
          icon={<Bell size={18} strokeWidth={2} />}
          title={t("Notifications")}
          sub={t(
            "Email, alerts, community updates — choose which signals reach you and where.",
          )}
        />
        <div className="rounded-xl border border-quality-q1/30 bg-quality-q1/10 p-5 text-sm text-red-700">
          {t("Could not load preferences: {error}", { error: loadError })}
        </div>
      </div>
    );
  }
  return (
    <div className="mx-auto w-full max-w-page animate-fade-in p-4 md:p-7">
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
            {t("Summary of your riding stats and community activity.")}
          </p>
        </div>
        <RadioCardGrid
          ariaLabel={t("Email digest frequency")}
          className="grid grid-cols-3 gap-2"
          value={prefs.email_digest}
          onChange={setDigest}
          options={EMAIL_DIGEST_OPTIONS.map((option) => ({
            ...option,
            label: t(option.label),
            description: t(option.description),
          }))}
        />
      </Card>

      {/* Per-category toggles */}
      <Card padded={false} className="mb-4 divide-y divide-line">
        <div className="flex items-center px-5 py-3">
          <Stamp className="flex-1">{t("Notification")}</Stamp>
          <div className="flex items-center gap-6">
            <Stamp className="flex w-10 items-center justify-center gap-1">
              <Mail size={12} />
              {t("Email")}
            </Stamp>
            <Stamp className="flex w-10 items-center justify-center gap-1">
              <Smartphone size={12} />
              {t("Push")}
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
                  {t(meta.label)}
                </p>
                <p className="mt-0.5 text-[12px] text-fg-dim">
                  {t(meta.description)}
                </p>
              </div>
              <div className="flex items-center gap-6">
                <Toggle
                  checked={toggles.email}
                  onChange={() => toggleChannel(category, "email")}
                  ariaLabel={t("{label} email", { label: t(meta.label) })}
                />
                <Toggle
                  checked={toggles.push}
                  onChange={() => toggleChannel(category, "push")}
                  ariaLabel={t("{label} push", { label: t(meta.label) })}
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
                "Product launches, deals with partners, seasonal riding guides. Opt-in only — off by default.",
              )}
            </p>
          </div>
          <Toggle
            checked={prefs.marketing_emails}
            onChange={toggleMarketing}
            ariaLabel={t("Marketing emails")}
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
  const t = useTranslation();
  return (
    <div className="flex items-center gap-3">
      <Button
        variant="accent"
        uppercase
        disabled={!isDirty}
        loading={saveState.kind === "saving"}
        onClick={onSave}
      >
        {saveState.kind === "saving" ? t("Saving…") : t("Save preferences")}
      </Button>
      {saveState.kind === "saved" && !isDirty && (
        <span className="inline-flex items-center gap-1 text-[13px] text-accent">
          <Check size={14} />
          {t("Saved")}
        </span>
      )}
      {saveState.kind === "error" && (
        <span className="text-[13px] text-red-700">{saveState.message}</span>
      )}
      {isDirty && saveState.kind !== "saving" && (
        <span className="text-[13px] text-fg-mute">{t("Unsaved changes")}</span>
      )}
    </div>
  );
}
