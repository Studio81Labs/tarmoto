"use client";
import { t } from "@/i18n";
import { useEffect, useState } from "react";
import { Check, Shield } from "lucide-react";
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
import type {
  LocationRetention,
  PrivacySettings,
  ProfileVisibility,
  RideSharingDefault,
} from "@/lib/types";
import {
  DEFAULT_PRIVACY_SETTINGS,
  LOCATION_RETENTION_OPTIONS,
  PROFILE_VISIBILITY_OPTIONS,
  RIDE_SHARING_OPTIONS,
  mergeWithDefaults,
  settingsEqual,
  type PartialPrivacySettings,
} from "@/lib/privacy-settings";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };
export default function PrivacyPage() {
  const [loading, setLoading] = useState(true);
  // Debounced: fast loads render content directly, no spinner flash.
  const showLoader = useDelayedLoading(loading);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [serverSettings, setServerSettings] = useState<PrivacySettings>(
    DEFAULT_PRIVACY_SETTINGS,
  );
  const [settings, setSettings] = useState<PrivacySettings>(
    DEFAULT_PRIVACY_SETTINGS,
  );
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  // Wait for the auth store to carry a token before fetching, so a hard
  // navigation here doesn't race AuthSync and surface as an
  // "Unauthorized" load error.
  const authReady = useAuthStore((s) => Boolean(s.accessToken));
  useEffect(() => {
    if (!authReady) return;
    let cancelled = false;
    accountApi
      .getPrivacySettings()
      .then(({ data }) => {
        if (cancelled) return;
        const merged = mergeWithDefaults(data as PartialPrivacySettings | null);
        setServerSettings(merged);
        setSettings(merged);
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
  const isDirty = !settingsEqual(settings, serverSettings);
  // Clear transient save state when the user edits, but never overwrite
  // an in-flight save — doing so would re-enable the save button and
  // allow a concurrent save to race the first.
  function clearTransientSaveState() {
    setSaveState((s) => (s.kind === "saving" ? s : { kind: "idle" }));
  }
  function setProfileVisibility(value: ProfileVisibility) {
    setSettings((p) => ({ ...p, profileVisibility: value }));
    clearTransientSaveState();
  }
  function setRideSharing(value: RideSharingDefault) {
    setSettings((p) => ({ ...p, defaultRideSharing: value }));
    clearTransientSaveState();
  }
  function setLocationRetention(value: LocationRetention) {
    setSettings((p) => ({ ...p, locationRetention: value }));
    clearTransientSaveState();
  }
  function toggleRoadData() {
    setSettings((p) => ({
      ...p,
      roadDataContribution: !p.roadDataContribution,
    }));
    clearTransientSaveState();
  }
  function toggleAnalytics() {
    setSettings((p) => ({ ...p, analyticsConsent: !p.analyticsConsent }));
    clearTransientSaveState();
  }
  function togglePersonalized() {
    setSettings((p) => ({
      ...p,
      personalizedRecommendationsConsent: !p.personalizedRecommendationsConsent,
    }));
    clearTransientSaveState();
  }
  async function save() {
    if (saveState.kind === "saving") return;
    setSaveState({ kind: "saving" });
    try {
      await accountApi.updatePrivacySettings(settings);
      setServerSettings(settings);
      setSaveState({ kind: "saved" });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not save settings";
      setSaveState({ kind: "error", message });
    }
  }
  if (loading) {
    return (
      <div className="mx-auto w-full max-w-page p-4 md:p-7">
        {showLoader && (
          <>
            <SkeletonPageHeader />
            <SkeletonForm sections={3} label={t("Loading settings… ")} />
          </>
        )}
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="mx-auto w-full max-w-page animate-fade-in p-4 md:p-7">
        <SettingsSubpageHeader
          stamp={t("Settings · Privacy")}
          icon={<Shield size={18} strokeWidth={2} />}
          title={t("Privacy")}
          sub={t(
            "Visibility, data sharing, consent — control what's public and what stays with you.",
          )}
        />
        <div className="rounded-xl border border-quality-q1/30 bg-quality-q1/10 p-5 text-sm text-red-400">
          {t("Could not load settings: ")}
          {loadError}
        </div>
      </div>
    );
  }
  return (
    <div className="mx-auto w-full max-w-page animate-fade-in p-4 md:p-7">
      <SettingsSubpageHeader
        stamp={t("Settings · Privacy")}
        icon={<Shield size={18} strokeWidth={2} />}
        title={t("Privacy")}
        sub={t(
          "Visibility, data sharing, consent — control what's public and what stays with you.",
        )}
      />

      {/* Profile visibility */}
      <Card padded={false} className="mb-4 p-[22px]">
        <div className="mb-4">
          <Stamp as="h2" className="mb-1 block">
            {t("Profile visibility ")}
          </Stamp>
          <p className="text-[12px] text-fg-dim">
            {t("Who can see your profile, stats, and shared rides. ")}
          </p>
        </div>
        <RadioCardGrid
          ariaLabel={t("Profile visibility")}
          className="grid grid-cols-1 gap-2 sm:grid-cols-3"
          value={settings.profileVisibility}
          onChange={setProfileVisibility}
          options={PROFILE_VISIBILITY_OPTIONS}
        />
      </Card>

      {/* Default ride sharing */}
      <Card padded={false} className="mb-4 p-[22px]">
        <div className="mb-4">
          <Stamp as="h2" className="mb-1 block">
            {t("Default ride sharing ")}
          </Stamp>
          <p className="text-[12px] text-fg-dim">
            {t(
              "How newly recorded rides are shared. You can always change visibility per ride. ",
            )}
          </p>
        </div>
        <RadioCardGrid
          ariaLabel={t("Default ride sharing")}
          className="grid grid-cols-1 gap-2 sm:grid-cols-2"
          value={settings.defaultRideSharing}
          onChange={setRideSharing}
          options={RIDE_SHARING_OPTIONS}
        />
      </Card>

      {/* Road data contribution */}
      <Card padded={false} className="mb-4 p-[22px]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[14px] font-semibold text-ink">
              {t("Contribute to road quality data ")}
            </p>
            <p className="mt-0.5 text-[12px] text-fg-dim">
              {t(
                "Share anonymized accelerometer readings from your rides so every Tarmoto rider gets a more accurate road quality map. No personal identifiers are attached. ",
              )}
            </p>
          </div>
          <Toggle
            checked={settings.roadDataContribution}
            onChange={toggleRoadData}
            ariaLabel="Road data contribution"
          />
        </div>
      </Card>

      {/* Location retention */}
      <Card padded={false} className="mb-4 p-[22px]">
        <div className="mb-4">
          <Stamp as="h2" className="mb-1 block">
            {t("Location data retention ")}
          </Stamp>
          <p className="text-[12px] text-fg-dim">
            {t(
              "How long your raw GPS traces are kept. Aggregate road-quality contributions (not linked to your account) remain indefinitely. ",
            )}
          </p>
        </div>
        <RadioCardGrid
          ariaLabel={t("Location data retention")}
          className="grid grid-cols-2 gap-2 sm:grid-cols-5"
          value={settings.locationRetention}
          onChange={setLocationRetention}
          options={LOCATION_RETENTION_OPTIONS}
        />
      </Card>

      {/* Data processing consent */}
      <Card padded={false} className="mb-6 divide-y divide-line">
        <header className="px-5 py-4">
          <Stamp as="h2" className="mb-1 block">
            {t("Data processing consent ")}
          </Stamp>
          <p className="text-[12px] text-fg-dim">
            {t(
              "You can opt out of optional processing at any time. Essential data needed to run the app (auth, rides you record) is always processed. ",
            )}
          </p>
        </header>

        <div className="flex items-start justify-between gap-4 px-5 py-4">
          <div>
            <p className="text-[14px] font-semibold text-ink">
              {t("Product analytics")}
            </p>
            <p className="mt-0.5 text-[12px] text-fg-dim">
              {t(
                "Help us improve Tarmoto with anonymized usage analytics (screen views, feature usage). ",
              )}
            </p>
          </div>
          <Toggle
            checked={settings.analyticsConsent}
            onChange={toggleAnalytics}
            ariaLabel="Product analytics consent"
          />
        </div>

        <div className="flex items-start justify-between gap-4 px-5 py-4">
          <div>
            <p className="text-[14px] font-semibold text-ink">
              {t("Personalised recommendations ")}
            </p>
            <p className="mt-0.5 text-[12px] text-fg-dim">
              {t(
                "Use your riding history to suggest routes, roads, and riders you may enjoy. ",
              )}
            </p>
          </div>
          <Toggle
            checked={settings.personalizedRecommendationsConsent}
            onChange={togglePersonalized}
            ariaLabel="Personalised recommendations consent"
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
