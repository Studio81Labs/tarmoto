"use client";
import { t } from "@/i18n";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Loader2 } from "lucide-react";
import { accountApi } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { Stamp } from "@/components/tarmoto/atoms";
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
export default function PrivacyPage() {
  const [loading, setLoading] = useState(true);
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
      <div className="p-6 max-w-page mx-auto">
        <div className="flex items-center gap-2 text-fg-dim">
          <Loader2 size={16} className="animate-spin" />
          {t("Loading settings\u2026 ")}
        </div>
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="p-6 max-w-page mx-auto animate-fade-in">
        <Link
          href="/settings"
          className="inline-flex items-center gap-1 text-sm text-fg-dim hover:text-ink mb-4 transition"
        >
          <ArrowLeft size={16} />
          {t("Settings ")}
        </Link>
        <Stamp className="block mb-2">{t("Privacy")}</Stamp>
        <h1 className="font-sans font-extrabold tracking-[-0.5px] leading-[1.05] text-[32px] text-ink mb-6">
          {t("Privacy & Data")}
        </h1>
        <div className="rounded-xl border border-quality-q1/30 bg-quality-q1/10 p-5 text-sm text-red-400">
          {t("Could not load settings: ")}
          {loadError}
        </div>
      </div>
    );
  }
  return (
    <div className="p-6 max-w-page mx-auto animate-fade-in">
      <Link
        href="/settings"
        className="inline-flex items-center gap-1 text-sm text-fg-dim hover:text-ink mb-4 transition"
      >
        <ArrowLeft size={16} />
        {t("Settings ")}
      </Link>
      <Stamp className="block mb-2">{t("Privacy")}</Stamp>
      <h1 className="font-sans font-extrabold tracking-[-0.5px] leading-[1.05] text-[32px] text-ink mb-3">
        {t("Privacy & Data")}
      </h1>
      <p className="text-sm text-fg-dim mb-6">
        {t(
          "Control who can see your profile, how your rides are shared, and what data Tarmoto retains and uses. ",
        )}
      </p>

      {/* Profile visibility */}
      <section className="rounded-2xl bg-cream border border-line p-[22px] mb-6">
        <div className="mb-4">
          <Stamp as="h2" className="block mb-1">
            {t("Profile visibility ")}
          </Stamp>
          <p className="text-xs text-fg-dim">
            {t("Who can see your profile, stats, and shared rides. ")}
          </p>
        </div>
        <div
          role="radiogroup"
          aria-label={t("Profile visibility")}
          className="grid grid-cols-1 sm:grid-cols-3 gap-2"
        >
          {PROFILE_VISIBILITY_OPTIONS.map((opt) => {
            const active = settings.profileVisibility === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setProfileVisibility(opt.value)}
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

      {/* Default ride sharing */}
      <section className="rounded-2xl bg-cream border border-line p-[22px] mb-6">
        <div className="mb-4">
          <Stamp as="h2" className="block mb-1">
            {t("Default ride sharing ")}
          </Stamp>
          <p className="text-xs text-fg-dim">
            {t(
              "How newly recorded rides are shared. You can always change visibility per ride. ",
            )}
          </p>
        </div>
        <div
          role="radiogroup"
          aria-label={t("Default ride sharing")}
          className="grid grid-cols-1 sm:grid-cols-2 gap-2"
        >
          {RIDE_SHARING_OPTIONS.map((opt) => {
            const active = settings.defaultRideSharing === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setRideSharing(opt.value)}
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

      {/* Road data contribution */}
      <section className="rounded-2xl bg-cream border border-line p-[22px] mb-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-ink">
              {t("Contribute to road quality data ")}
            </p>
            <p className="text-xs text-fg-dim mt-0.5">
              {t(
                "Share anonymized accelerometer readings from your rides so every Tarmoto rider gets a more accurate road quality map. No personal identifiers are attached. ",
              )}
            </p>
          </div>
          <Toggle
            label="Road data contribution"
            enabled={settings.roadDataContribution}
            onToggle={toggleRoadData}
          />
        </div>
      </section>

      {/* Location retention */}
      <section className="rounded-2xl bg-cream border border-line p-[22px] mb-6">
        <div className="mb-4">
          <Stamp as="h2" className="block mb-1">
            {t("Location data retention ")}
          </Stamp>
          <p className="text-xs text-fg-dim">
            {t(
              "How long your raw GPS traces are kept. Aggregate road-quality contributions (not linked to your account) remain indefinitely. ",
            )}
          </p>
        </div>
        <div
          role="radiogroup"
          aria-label={t("Location data retention")}
          className="grid grid-cols-2 sm:grid-cols-5 gap-2"
        >
          {LOCATION_RETENTION_OPTIONS.map((opt) => {
            const active = settings.locationRetention === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setLocationRetention(opt.value)}
                className={`flex flex-col items-start gap-0.5 px-3 py-2.5 rounded-lg border text-left transition ${
                  active
                    ? "border-ink bg-ink text-cream"
                    : "border-line bg-paper text-ink hover:border-line-strong"
                }`}
              >
                <span className="text-sm font-semibold">{opt.label}</span>
                {opt.description && (
                  <span
                    className={`text-xs ${active ? "text-fg-on-dark-dim" : "text-fg-dim"}`}
                  >
                    {opt.description}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </section>

      {/* Data processing consent */}
      <section className="rounded-2xl bg-cream border border-line divide-y divide-line mb-6">
        <header className="px-5 py-4">
          <Stamp as="h2" className="block mb-1">
            {t("Data processing consent ")}
          </Stamp>
          <p className="text-xs text-fg-dim">
            {t(
              "You can opt out of optional processing at any time. Essential data needed to run the app (auth, rides you record) is always processed. ",
            )}
          </p>
        </header>

        <div className="px-5 py-4 flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-ink">
              {t("Product analytics")}
            </p>
            <p className="text-xs text-fg-dim mt-0.5">
              {t(
                "Help us improve Tarmoto with anonymized usage analytics (screen views, feature usage). ",
              )}
            </p>
          </div>
          <Toggle
            label="Product analytics consent"
            enabled={settings.analyticsConsent}
            onToggle={toggleAnalytics}
          />
        </div>

        <div className="px-5 py-4 flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-ink">
              {t("Personalized recommendations ")}
            </p>
            <p className="text-xs text-fg-dim mt-0.5">
              {t(
                "Use your riding history to suggest routes, roads, and riders you may enjoy. ",
              )}
            </p>
          </div>
          <Toggle
            label="Personalized recommendations consent"
            enabled={settings.personalizedRecommendationsConsent}
            onToggle={togglePersonalized}
          />
        </div>
      </section>

      {/* Save bar */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={!isDirty || saveState.kind === "saving"}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-ink font-bold text-[11px] uppercase tracking-[0.2px] hover:brightness-95 transition disabled:opacity-50 disabled:cursor-not-allowed"
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
interface ToggleProps {
  enabled: boolean;
  onToggle: () => void;
  label: string;
}
function Toggle({ enabled, onToggle, label }: ToggleProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={enabled}
      aria-label={label}
      className={`relative w-9 h-5 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-accent/40 flex-shrink-0 ${enabled ? "bg-ink" : "bg-ink/12"}`}
    >
      <span
        className={`absolute top-0.5 w-4 h-4 rounded-full transform transition-transform ${enabled ? "bg-accent left-0.5 translate-x-4" : "bg-cream left-0.5"}`}
      />
    </button>
  );
}
