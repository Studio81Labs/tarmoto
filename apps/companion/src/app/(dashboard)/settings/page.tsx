"use client";
import { t } from "@/i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import QRCode from "qrcode";
import { useAuthStore } from "@/stores/auth";
import { usePreferencesStore } from "@/stores/preferences";
import { usersApi } from "@/lib/api";
import { buildLinkAccountDeepLink } from "@/lib/account-link";
import type { UnitSystem } from "@tarmoto/shared";
import {
  User,
  CreditCard,
  Shield,
  Bell,
  Bike,
  ChevronRight,
  Database,
  Copy,
  Smartphone,
} from "lucide-react";
const SETTINGS_SECTIONS = [
  {
    href: "/settings",
    icon: User,
    label: "Profile",
    description: "Display name, bio, home region",
  },
  {
    href: "/settings/subscription",
    icon: CreditCard,
    label: "Subscription",
    description: "Plan, billing, payment methods",
  },
  {
    href: "/settings/privacy",
    icon: Shield,
    label: "Privacy",
    description: "Visibility, data sharing, consent",
  },
  {
    href: "/settings/bikes",
    icon: Bike,
    label: "My Bikes",
    description: "Manage your motorcycle garage",
  },
  {
    href: "/settings/notifications",
    icon: Bell,
    label: "Notifications",
    description: "Email, alerts, community updates",
  },
  {
    href: "/settings/data",
    icon: Database,
    label: "Data & Account",
    description: "Export your data or delete your account",
  },
];
type SaveState = "idle" | "saving" | "saved" | "error";
type CopyState = "idle" | "copied" | "error";
type AvatarUploadState = "idle" | "uploading" | "uploaded" | "error";
export default function AccountPage() {
  const user = useAuthStore((s) => s.user);
  const setAuthUser = useAuthStore((s) => s.setUser);
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [homeRegion, setHomeRegion] = useState("");
  const [bio, setBio] = useState("");
  const [didHydrateProfile, setDidHydrateProfile] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [mobileLinkQrSrc, setMobileLinkQrSrc] = useState<string | null>(null);
  const [avatarUploadState, setAvatarUploadState] =
    useState<AvatarUploadState>("idle");
  const [avatarUploadError, setAvatarUploadError] = useState<string | null>(
    null,
  );
  // Per-field dirty flags — set on first keystroke so a late GET response
  // can't clobber what the user just typed, and so an unhydrated save
  // doesn't blindly send empty values that would blank the server row.
  const avatarDirtyRef = useRef(false);
  const bioDirtyRef = useRef(false);
  const homeRegionDirtyRef = useRef(false);
  const saveResetTimerRef = useRef<number | null>(null);
  const copyResetTimerRef = useRef<number | null>(null);
  // `useState(user?.displayName ?? "")` only captures the value at first
  // render. When Auth.js finishes hydrating the session after mount, the
  // local field would otherwise stay blank and a later "Save" could wipe the
  // real display name. Syncing from the store keeps the editable field aligned.
  useEffect(() => {
    if (user?.displayName) setDisplayName(user.displayName);
  }, [user?.displayName]);
  // Pull bio / home_region from the backend — they don't live on the
  // NextAuth session (which intentionally keeps only ID-shaped fields).
  useEffect(() => {
    let cancelled = false;
    usersApi
      .getMe()
      .then(({ data }) => {
        if (cancelled) return;
        if (!avatarDirtyRef.current) setAvatarUrl(data.avatar_url ?? "");
        // Don't overwrite a field the user has already started editing
        // if the GET races with early typing.
        if (!bioDirtyRef.current) setBio(data.bio ?? "");
        if (!homeRegionDirtyRef.current) setHomeRegion(data.home_region ?? "");
        setDidHydrateProfile(true);
      })
      .catch(() => {
        // Silent on load — the form is still usable. But crucially keep
        // didHydrateProfile=false so handleSave below won't blank server
        // fields we never successfully read.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  // Clean up any pending transient status timers on unmount.
  useEffect(() => {
    return () => {
      if (saveResetTimerRef.current !== null) {
        window.clearTimeout(saveResetTimerRef.current);
      }
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
    };
  }, []);
  const unitSystem = usePreferencesStore((s) => s.unitSystem);
  const setUnitSystem = usePreferencesStore((s) => s.setUnitSystem);
  const hydratePreferences = usePreferencesStore((s) => s.hydrate);
  useEffect(() => {
    hydratePreferences();
  }, [hydratePreferences]);
  const previewAvatarUrl = normalizeAvatarUrl(avatarUrl);
  const handleSave = useCallback(async () => {
    if (saveResetTimerRef.current !== null) {
      window.clearTimeout(saveResetTimerRef.current);
      saveResetTimerRef.current = null;
    }
    const trimmedName = displayName.trim();
    if (!trimmedName) {
      setSaveState("error");
      setSaveError("Display name is required.");
      return;
    }
    if (avatarDirtyRef.current && avatarUrl.trim() && !previewAvatarUrl) {
      setSaveState("error");
      setSaveError("Avatar URL must be a valid http:// or https:// address.");
      return;
    }
    setSaveState("saving");
    setSaveError(null);
    // Build a partial payload — only include fields we either confirmed
    // (hydrated from the server) or the user has touched. This keeps a
    // failed GET from turning into an accidental "save null over the top
    // of the existing bio/home_region".
    const payload: {
      display_name: string;
      avatar_url?: string | null;
      bio?: string | null;
      home_region?: string | null;
    } = { display_name: trimmedName };
    if (avatarDirtyRef.current) {
      payload.avatar_url = previewAvatarUrl;
    }
    if (didHydrateProfile || bioDirtyRef.current) {
      payload.bio = bio.trim() || null;
    }
    if (didHydrateProfile || homeRegionDirtyRef.current) {
      payload.home_region = homeRegion.trim() || null;
    }
    try {
      const { data } = await usersApi.updateMe(payload);
      if (user) {
        setAuthUser({ ...user, displayName: data.display_name });
      }
      setSaveState("saved");
      if (saveResetTimerRef.current !== null) {
        window.clearTimeout(saveResetTimerRef.current);
      }
      saveResetTimerRef.current = window.setTimeout(() => {
        setSaveState("idle");
        saveResetTimerRef.current = null;
      }, 2000);
    } catch (err) {
      if (saveResetTimerRef.current !== null) {
        window.clearTimeout(saveResetTimerRef.current);
        saveResetTimerRef.current = null;
      }
      setSaveState("error");
      setSaveError(
        err instanceof Error ? err.message : "Could not save your profile.",
      );
    }
  }, [
    displayName,
    avatarUrl,
    previewAvatarUrl,
    bio,
    homeRegion,
    user,
    setAuthUser,
    didHydrateProfile,
  ]);
  const handleCopySignInEmail = useCallback(async () => {
    if (!user?.email) return;
    if (copyResetTimerRef.current !== null) {
      window.clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = null;
    }
    try {
      await navigator.clipboard.writeText(user.email);
      setCopyState("copied");
      copyResetTimerRef.current = window.setTimeout(() => {
        setCopyState("idle");
        copyResetTimerRef.current = null;
      }, 2000);
    } catch {
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
        copyResetTimerRef.current = null;
      }
      setCopyState("error");
    }
  }, [user?.email]);
  const handleAvatarFileChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      setAvatarUploadState("uploading");
      setAvatarUploadError(null);
      try {
        const { data } = await usersApi.uploadAvatar(file);
        avatarDirtyRef.current = false;
        setAvatarUrl(data.avatar_url ?? "");
        setDidHydrateProfile(true);
        setAvatarUploadState("uploaded");
      } catch (err) {
        setAvatarUploadState("error");
        setAvatarUploadError(
          err instanceof Error ? err.message : "Could not upload your photo.",
        );
      }
    },
    [],
  );
  const mobileLinkHref = user?.email
    ? buildLinkAccountDeepLink(user.email)
    : null;
  useEffect(() => {
    let cancelled = false;
    if (!mobileLinkHref) {
      setMobileLinkQrSrc(null);
      return () => {
        cancelled = true;
      };
    }
    QRCode.toDataURL(mobileLinkHref, {
      margin: 1,
      width: 176,
      color: {
        dark: "#0f172a",
        light: "#f8fafc",
      },
    })
      .then((src) => {
        if (!cancelled) setMobileLinkQrSrc(src);
      })
      .catch(() => {
        if (!cancelled) setMobileLinkQrSrc(null);
      });
    return () => {
      cancelled = true;
    };
  }, [mobileLinkHref]);
  return (
    <div className="p-6 max-w-page-narrow mx-auto animate-fade-in">
      <h1 className="text-2xl font-bold mb-6">{t("Settings")}</h1>

      {/* Settings navigation */}
      <div className="space-y-1 mb-8">
        {SETTINGS_SECTIONS.map((section) => (
          <Link
            key={section.href}
            href={section.href}
            className="flex items-center gap-4 p-4 rounded-xl hover:bg-slate-900 transition group"
          >
            <div className="p-2 rounded-lg bg-slate-800 text-slate-400 group-hover:text-tarmoto-cyan transition">
              <section.icon size={18} />
            </div>
            <div className="flex-1">
              <p className="text-sm font-medium text-white">{section.label}</p>
              <p className="text-xs text-slate-500">{section.description}</p>
            </div>
            <ChevronRight size={16} className="text-slate-600" />
          </Link>
        ))}
      </div>

      {/* Profile form */}
      <div className="rounded-2xl bg-slate-900 border border-slate-800 p-6 space-y-4">
        <h2 className="text-lg font-semibold mb-4">{t("Profile")}</h2>

        <div className="flex items-center gap-4 mb-6">
          {previewAvatarUrl ? (
            // Browser-native <img>: avatar URLs come from arbitrary providers
            // (social login, etc.), so we'd need to enumerate every domain in
            // next.config.ts to use next/image — not practical here.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={previewAvatarUrl}
              alt={
                displayName
                  ? `${displayName}'s profile photo`
                  : "Your profile photo"
              }
              className="w-16 h-16 rounded-full object-cover"
            />
          ) : (
            <div
              aria-hidden="true"
              className="w-16 h-16 rounded-full bg-tarmoto-cyan/20 flex items-center justify-center text-tarmoto-cyan text-xl font-bold"
            >
              {displayName[0]?.toUpperCase() ?? "T"}
            </div>
          )}
          <div className="flex flex-col">
            <p className="text-xs text-slate-500 mt-1">
              {t(
                "Upload a photo here, or paste a hosted image URL to keep your web and mobile profile photo in sync today. ",
              )}
            </p>
          </div>
        </div>

        <div>
          <label
            htmlFor="settings-avatar-file"
            className="block text-sm text-slate-400 mb-1.5"
          >
            {t("Upload avatar ")}
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <input
              id="settings-avatar-file"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={handleAvatarFileChange}
              className="block text-sm text-slate-300 file:mr-4 file:rounded-lg file:border-0 file:bg-slate-800 file:px-4 file:py-2.5 file:text-sm file:font-medium file:text-white hover:file:bg-slate-700"
              aria-label={t("Upload avatar")}
            />
            {avatarUploadState === "uploading" && (
              <span
                role="status"
                aria-live="polite"
                className="text-sm text-slate-400"
              >
                {t("Uploading\u2026 ")}
              </span>
            )}
            {avatarUploadState === "uploaded" && (
              <span
                role="status"
                aria-live="polite"
                className="text-sm text-emerald-400"
              >
                {t("Photo uploaded. ")}
              </span>
            )}
            {avatarUploadState === "error" && avatarUploadError && (
              <span
                role="alert"
                aria-live="assertive"
                className="text-sm text-rose-400"
              >
                {avatarUploadError}
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 mt-1">
            {t("PNG, JPEG, or WebP up to 5 MB. ")}
          </p>
        </div>

        <div>
          <label
            htmlFor="settings-avatar-url"
            className="block text-sm text-slate-400 mb-1.5"
          >
            {t("Avatar URL ")}
          </label>
          <div className="flex gap-2">
            <input
              id="settings-avatar-url"
              type="url"
              value={avatarUrl}
              onChange={(e) => {
                avatarDirtyRef.current = true;
                setAvatarUploadState("idle");
                setAvatarUploadError(null);
                setAvatarUrl(e.target.value);
              }}
              placeholder={t("https://cdn.example.com/rider.jpg")}
              className="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm placeholder:text-slate-500 focus:outline-none focus:border-tarmoto-cyan transition"
            />
            <button
              type="button"
              onClick={() => {
                avatarDirtyRef.current = true;
                setAvatarUploadState("idle");
                setAvatarUploadError(null);
                setAvatarUrl("");
              }}
              className="px-3 py-2.5 rounded-lg bg-slate-800 text-slate-300 text-sm hover:bg-slate-700 transition"
            >
              {t("Remove ")}
            </button>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            {t("Use an ")}
            <code>{t("https://")}</code>
            {t(" image URL from your CDN, photo host, or social profile. ")}
          </p>
        </div>

        <div>
          <label
            htmlFor="settings-display-name"
            className="block text-sm text-slate-400 mb-1.5"
          >
            {t("Display name ")}
          </label>
          <input
            id="settings-display-name"
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={100}
            className="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:outline-none focus:border-tarmoto-cyan transition"
          />
        </div>

        <div>
          <label
            htmlFor="settings-email"
            className="block text-sm text-slate-400 mb-1.5"
          >
            {t("Email ")}
          </label>
          <input
            id="settings-email"
            type="email"
            value={user?.email ?? ""}
            disabled
            className="w-full px-4 py-2.5 rounded-lg bg-slate-800/50 border border-slate-700/50 text-slate-500 text-sm"
          />
        </div>

        <div>
          <label
            htmlFor="settings-bio"
            className="block text-sm text-slate-400 mb-1.5"
          >
            {t("Bio ")}
          </label>
          <textarea
            id="settings-bio"
            value={bio}
            onChange={(e) => {
              bioDirtyRef.current = true;
              setBio(e.target.value);
            }}
            maxLength={500}
            rows={3}
            placeholder={t(
              "A short blurb about your riding \u2014 shown on your public profile.",
            )}
            className="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm placeholder:text-slate-500 focus:outline-none focus:border-tarmoto-cyan transition resize-none"
          />
          <p className="text-xs text-slate-500 mt-1">{bio.length}/500</p>
        </div>

        <div>
          <label
            htmlFor="settings-home-region"
            className="block text-sm text-slate-400 mb-1.5"
          >
            {t("Home region ")}
          </label>
          <input
            id="settings-home-region"
            type="text"
            value={homeRegion}
            onChange={(e) => {
              homeRegionDirtyRef.current = true;
              setHomeRegion(e.target.value);
            }}
            maxLength={120}
            placeholder={t("e.g., Beskydy, Czech Republic")}
            className="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm placeholder:text-slate-500 focus:outline-none focus:border-tarmoto-cyan transition"
          />
        </div>

        <div className="flex items-center gap-3 pt-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={saveState === "saving"}
            className="px-4 py-2 rounded-lg bg-tarmoto-cyan text-slate-950 font-semibold text-sm hover:bg-tarmoto-cyan-light transition disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {saveState === "saving" ? "Saving…" : "Save changes"}
          </button>
          {saveState === "saved" && (
            <span
              role="status"
              aria-live="polite"
              className="text-sm text-emerald-400"
            >
              {t("Saved ")}
            </span>
          )}
          {saveState === "error" && saveError && (
            <span
              role="alert"
              aria-live="assertive"
              className="text-sm text-rose-400"
            >
              {saveError}
            </span>
          )}
        </div>
      </div>

      <div className="rounded-2xl bg-slate-900 border border-slate-800 p-6 mt-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold mb-1">
              {t("Link mobile app")}
            </h2>
            <p className="text-sm text-slate-500">
              {t(
                "Sign in on iPhone or Android with this same Tarmoto account to sync your rides, bikes, and profile details across devices. ",
              )}
            </p>
          </div>
          <div className="rounded-xl bg-slate-800/80 p-3 text-tarmoto-cyan">
            <Smartphone size={20} />
          </div>
        </div>
        <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/70 p-4">
          <p className="text-sm text-slate-300">
            {t(
              "Scan the QR code or open Tarmoto on this phone to jump into mobile account linking, then sign in with the same credentials to keep everything in sync. ",
            )}
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-4">
            <div className="rounded-2xl border border-slate-800 bg-slate-900 p-3">
              {mobileLinkQrSrc ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={mobileLinkQrSrc}
                  alt={t("QR code to link the Tarmoto mobile app")}
                  className="h-36 w-36 rounded-lg"
                />
              ) : (
                <div className="flex h-36 w-36 items-center justify-center rounded-lg bg-slate-950 text-xs text-slate-500">
                  {t("QR unavailable ")}
                </div>
              )}
            </div>
            <div className="max-w-sm space-y-3">
              <p className="text-xs text-slate-500">
                {t(
                  "Best on another device: open your phone camera, scan the code, and Tarmoto will jump straight to account linking with your email prefilled. ",
                )}
              </p>
              {mobileLinkHref ? (
                <a
                  href={mobileLinkHref}
                  className="inline-flex items-center gap-2 rounded-lg border border-tarmoto-cyan/30 bg-tarmoto-cyan/10 px-4 py-2 text-sm font-medium text-tarmoto-cyan transition hover:border-tarmoto-cyan/50 hover:bg-tarmoto-cyan/15"
                >
                  <Smartphone size={14} />
                  {t("Open in Tarmoto mobile ")}
                </a>
              ) : null}
            </div>
          </div>

          <p className="text-xs uppercase tracking-widest text-slate-500">
            {t("Sign-in email ")}
          </p>
          <p className="mt-1 break-all font-mono text-sm text-slate-200">
            {user?.email ?? "No account email available"}
          </p>
          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              onClick={handleCopySignInEmail}
              disabled={!user?.email}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-800 text-slate-200 text-sm font-medium hover:bg-slate-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Copy size={14} />
              {t("Copy sign-in email ")}
            </button>
            {copyState === "copied" && (
              <span role="status" className="text-sm text-emerald-400">
                {t("Email copied. Use it to sign in on mobile. ")}
              </span>
            )}
            {copyState === "error" && (
              <span role="alert" className="text-sm text-rose-400">
                {t("Could not copy your email. Please copy it manually. ")}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-2xl bg-slate-900 border border-slate-800 p-6 mt-4">
        <h2 className="text-lg font-semibold mb-1">{t("Display units")}</h2>
        <p className="text-sm text-slate-500 mb-4">
          {t(
            "Choose how distances and speeds are shown across the dashboard. ",
          )}
        </p>
        {/*
          Native radio inputs (visually hidden) carry browser-native keyboard
          semantics — arrow keys move selection, only the checked input is in
          the tab order — which a custom button-based radiogroup would need to
          re-implement manually. The visible labels provide the styling.
        */}
        <div
          role="radiogroup"
          aria-label={t("Display units")}
          className="inline-flex rounded-lg bg-slate-800 p-1"
        >
          {(["metric", "imperial"] as UnitSystem[]).map((value) => (
            <label
              key={value}
              className={`relative px-4 py-1.5 rounded-md text-sm transition cursor-pointer ${
                unitSystem === value
                  ? "bg-tarmoto-cyan text-slate-950 font-semibold"
                  : "text-slate-300 hover:text-white"
              }`}
            >
              <input
                type="radio"
                name="unit-system"
                value={value}
                checked={unitSystem === value}
                onChange={() => setUnitSystem(value)}
                className="sr-only"
                aria-label={
                  value === "metric"
                    ? "Use metric units (kilometres)"
                    : "Use imperial units (miles)"
                }
              />
              {value === "metric" ? "Metric (km)" : "Imperial (mi)"}
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
function normalizeAvatarUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}
