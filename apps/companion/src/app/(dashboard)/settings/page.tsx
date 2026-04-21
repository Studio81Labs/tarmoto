"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useAuthStore } from "@/stores/auth";
import { usePreferencesStore } from "@/stores/preferences";
import { usersApi, type UserProfileResponse } from "@/lib/api";
import type { UnitSystem } from "@tarmoto/shared";
import {
  User,
  CreditCard,
  Shield,
  Bell,
  Bike,
  ChevronRight,
  Database,
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

export default function AccountPage() {
  const user = useAuthStore((s) => s.user);
  const setAuthUser = useAuthStore((s) => s.setUser);
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [homeRegion, setHomeRegion] = useState("");
  const [bio, setBio] = useState("");
  const [profile, setProfile] = useState<UserProfileResponse | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

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
        setProfile(data);
        setBio(data.bio ?? "");
        setHomeRegion(data.home_region ?? "");
      })
      .catch(() => {
        // Silent: the form is still usable — fields just stay empty until
        // the user types. The PATCH-side error banner surfaces any write
        // failure, which is what actually matters.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const unitSystem = usePreferencesStore((s) => s.unitSystem);
  const setUnitSystem = usePreferencesStore((s) => s.setUnitSystem);
  const hydratePreferences = usePreferencesStore((s) => s.hydrate);
  useEffect(() => {
    hydratePreferences();
  }, [hydratePreferences]);

  const handleSave = useCallback(async () => {
    const trimmedName = displayName.trim();
    if (!trimmedName) {
      setSaveState("error");
      setSaveError("Display name is required.");
      return;
    }
    setSaveState("saving");
    setSaveError(null);
    try {
      const { data } = await usersApi.updateMe({
        display_name: trimmedName,
        bio: bio.trim() || null,
        home_region: homeRegion.trim() || null,
      });
      setProfile(data);
      if (user) {
        setAuthUser({ ...user, displayName: data.display_name });
      }
      setSaveState("saved");
      window.setTimeout(() => setSaveState("idle"), 2000);
    } catch (err) {
      setSaveState("error");
      setSaveError(
        err instanceof Error ? err.message : "Could not save your profile.",
      );
    }
  }, [displayName, bio, homeRegion, user, setAuthUser]);

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
          {profile?.avatar_url ? (
            // Browser-native <img>: avatar URLs come from arbitrary providers
            // (social login, etc.), so we'd need to enumerate every domain in
            // next.config.ts to use next/image — not practical here.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={profile.avatar_url}
              alt=""
              className="w-16 h-16 rounded-full object-cover"
            />
          ) : (
            <div className="w-16 h-16 rounded-full bg-tarmoto-cyan/20 flex items-center justify-center text-tarmoto-cyan text-xl font-bold">
              {displayName[0]?.toUpperCase() ?? "T"}
            </div>
          )}
          <button
            type="button"
            disabled
            title="Photo upload is coming in a follow-up (needs file storage)"
            className="px-3 py-1.5 rounded-lg bg-slate-800 text-slate-500 text-sm cursor-not-allowed"
          >
            Change photo
          </button>
        </div>

        <div>
          <label className="block text-sm text-slate-400 mb-1.5">
            Display name
          </label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={100}
            className="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:outline-none focus:border-tarmoto-cyan transition"
          />
        </div>

        <div>
          <label className="block text-sm text-slate-400 mb-1.5">Email</label>
          <input
            type="email"
            value={user?.email ?? ""}
            disabled
            className="w-full px-4 py-2.5 rounded-lg bg-slate-800/50 border border-slate-700/50 text-slate-500 text-sm"
          />
        </div>

        <div>
          <label className="block text-sm text-slate-400 mb-1.5">Bio</label>
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            maxLength={500}
            rows={3}
            placeholder="A short blurb about your riding — shown on your public profile."
            className="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm placeholder:text-slate-500 focus:outline-none focus:border-tarmoto-cyan transition resize-none"
          />
          <p className="text-xs text-slate-500 mt-1">{bio.length}/500</p>
        </div>

        <div>
          <label className="block text-sm text-slate-400 mb-1.5">
            Home region
          </label>
          <input
            type="text"
            value={homeRegion}
            onChange={(e) => setHomeRegion(e.target.value)}
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
