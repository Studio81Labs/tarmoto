"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAuthStore } from "@/stores/auth";
import { usePreferencesStore } from "@/stores/preferences";
import { usersApi } from "@/lib/api";
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
    try {
      await navigator.clipboard.writeText(user.email);
      setCopyState("copied");
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
      copyResetTimerRef.current = window.setTimeout(() => {
        setCopyState("idle");
        copyResetTimerRef.current = null;
      }, 2000);
    } catch {
      setCopyState("error");
    }
  }, [user?.email]);

  return (
    <div className="p-6 max-w-3xl mx-auto animate-fade-in">
      <h1 className="text-2xl font-bold mb-6">Settings</h1>

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
        <h2 className="text-lg font-semibold mb-4">Profile</h2>

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
              Paste a hosted image URL to keep your web and mobile profile photo
              in sync today.
            </p>
          </div>
        </div>

        <div>
          <label
            htmlFor="settings-avatar-url"
            className="block text-sm text-slate-400 mb-1.5"
          >
            Avatar URL
          </label>
          <div className="flex gap-2">
            <input
              id="settings-avatar-url"
              type="url"
              value={avatarUrl}
              onChange={(e) => {
                avatarDirtyRef.current = true;
                setAvatarUrl(e.target.value);
              }}
              placeholder="https://cdn.example.com/rider.jpg"
              className="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm placeholder:text-slate-500 focus:outline-none focus:border-tarmoto-cyan transition"
            />
            <button
              type="button"
              onClick={() => {
                avatarDirtyRef.current = true;
                setAvatarUrl("");
              }}
              className="px-3 py-2.5 rounded-lg bg-slate-800 text-slate-300 text-sm hover:bg-slate-700 transition"
            >
              Remove
            </button>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Use an `https://` image URL from your CDN, photo host, or social
            profile.
          </p>
        </div>

        <div>
          <label
            htmlFor="settings-display-name"
            className="block text-sm text-slate-400 mb-1.5"
          >
            Display name
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
            Email
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
            Bio
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
            placeholder="A short blurb about your riding — shown on your public profile."
            className="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm placeholder:text-slate-500 focus:outline-none focus:border-tarmoto-cyan transition resize-none"
          />
          <p className="text-xs text-slate-500 mt-1">{bio.length}/500</p>
        </div>

        <div>
          <label
            htmlFor="settings-home-region"
            className="block text-sm text-slate-400 mb-1.5"
          >
            Home region
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
            placeholder="e.g., Beskydy, Czech Republic"
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
              Saved
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
            <h2 className="text-lg font-semibold mb-1">Link mobile app</h2>
            <p className="text-sm text-slate-500">
              Sign in on iPhone or Android with this same Tarmoto account to
              sync your rides, bikes, and profile details across devices.
            </p>
          </div>
          <div className="rounded-xl bg-slate-800/80 p-3 text-tarmoto-cyan">
            <Smartphone size={20} />
          </div>
        </div>
        <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/70 p-4">
          <p className="text-xs uppercase tracking-widest text-slate-500">
            Sign-in email
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
              Copy sign-in email
            </button>
            {copyState === "copied" && (
              <span role="status" className="text-sm text-emerald-400">
                Email copied. Use it to sign in on mobile.
              </span>
            )}
            {copyState === "error" && (
              <span role="alert" className="text-sm text-rose-400">
                Could not copy your email. Please copy it manually.
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-2xl bg-slate-900 border border-slate-800 p-6 mt-4">
        <h2 className="text-lg font-semibold mb-1">Display units</h2>
        <p className="text-sm text-slate-500 mb-4">
          Choose how distances and speeds are shown across the dashboard.
        </p>
        {/*
          Native radio inputs (visually hidden) carry browser-native keyboard
          semantics — arrow keys move selection, only the checked input is in
          the tab order — which a custom button-based radiogroup would need to
          re-implement manually. The visible labels provide the styling.
        */}
        <div
          role="radiogroup"
          aria-label="Display units"
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
