"use client";
import { t } from "@/i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { useAuthStore } from "@/stores/auth";
import { usePreferencesStore } from "@/stores/preferences";
import { usersApi } from "@/lib/api";
import { buildLinkAccountDeepLink } from "@/lib/account-link";
import type { UnitSystem } from "@tarmoto/shared";
import { Button, Card, Stamp } from "@tarmoto/ui";
import { LocaleSwitcher } from "@/components/LocaleSwitcher";
import { Copy, Smartphone, User } from "lucide-react";
import { SettingsSubpageHeader } from "../_SettingsSubpageHeader";
type SaveState = "idle" | "saving" | "saved" | "error";
type CopyState = "idle" | "copied" | "error";
type AvatarUploadState = "idle" | "uploading" | "uploaded" | "error";
export default function ProfilePage() {
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
  // Surface the rider's join date in the spec's avatar hero row. Hydrated
  // from `/users/me`; the auth-store user shape doesn't carry `created_at`.
  const [joinedAt, setJoinedAt] = useState<string | null>(null);
  // Triggered by the spec's `Change avatar` pill so the visible CTA drives
  // the hidden file input — keeps the avatar row spec-clean without
  // dropping the file-upload functionality.
  const avatarFileInputRef = useRef<HTMLInputElement | null>(null);
  // Per-field dirty flags — set on first keystroke so a late GET response
  // can't clobber what the user just typed, and so an unhydrated save
  // doesn't blindly send empty values that would blank the server row.
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
        // The avatar URL is server-owned end-to-end now (upload mutates
        // it directly via `/users/me/avatar`), so the GET is always the
        // source of truth.
        setAvatarUrl(data.avatar_url ?? "");
        // Don't overwrite a field the user has already started editing
        // if the GET races with early typing.
        if (!bioDirtyRef.current) setBio(data.bio ?? "");
        if (!homeRegionDirtyRef.current) setHomeRegion(data.home_region ?? "");
        setJoinedAt(data.created_at ?? null);
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
  const joinedLabel = joinedAt
    ? new Date(joinedAt).toLocaleDateString(undefined, {
        month: "short",
        year: "numeric",
      })
    : null;
  // Spec pairs `Save changes` with `Cancel`. Cancel rolls every edited
  // field back to the last server-confirmed value, drops any save
  // errors, and clears the per-field dirty markers so a subsequent
  // hydration tick can't overwrite the wrong field.
  //
  // Source of truth is the fresh `/users/me` response — the auth-store
  // displayName can lag behind a change made in another tab / session,
  // so reading display_name from the same refetch keeps every field
  // consistent (and rescues the case where the auth user is missing).
  //
  // A failed refetch leaves the edited fields on screen (we can't roll
  // back without server state) and surfaces the error via the same
  // `saveState`/`saveError` channel the form already uses — silently
  // doing nothing would look like Cancel was a no-op.
  const handleCancel = useCallback(async () => {
    setSaveState("idle");
    setSaveError(null);
    try {
      const { data } = await usersApi.getMe();
      setDisplayName(data.display_name ?? "");
      setAvatarUrl(data.avatar_url ?? "");
      setBio(data.bio ?? "");
      setHomeRegion(data.home_region ?? "");
      bioDirtyRef.current = false;
      homeRegionDirtyRef.current = false;
    } catch (err) {
      setSaveState("error");
      setSaveError(
        err instanceof Error
          ? err.message
          : t("Could not reset your profile. Please try again."),
      );
    }
  }, []);
  const handleSave = useCallback(async () => {
    if (saveResetTimerRef.current !== null) {
      window.clearTimeout(saveResetTimerRef.current);
      saveResetTimerRef.current = null;
    }
    const trimmedName = displayName.trim();
    if (!trimmedName) {
      setSaveState("error");
      setSaveError(t("Display name is required."));
      return;
    }
    setSaveState("saving");
    setSaveError(null);
    // Build a partial payload — only include fields we either confirmed
    // (hydrated from the server) or the user has touched. This keeps a
    // failed GET from turning into an accidental "save null over the top
    // of the existing bio/home_region". `avatar_url` is intentionally
    // omitted: the dedicated `/users/me/avatar` upload endpoint is the
    // only path that mutates it, so the form's PATCH has no business
    // shipping a value that could only have come from a stale local copy.
    const payload: {
      display_name: string;
      bio?: string | null;
      home_region?: string | null;
    } = { display_name: trimmedName };
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
        err instanceof Error ? err.message : t("Could not save your profile."),
      );
    }
  }, [displayName, bio, homeRegion, user, setAuthUser, didHydrateProfile]);
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
        setAvatarUrl(data.avatar_url ?? "");
        setDidHydrateProfile(true);
        setAvatarUploadState("uploaded");
      } catch (err) {
        setAvatarUploadState("error");
        setAvatarUploadError(
          err instanceof Error
            ? err.message
            : t("Could not upload your photo."),
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
        // ink dots on cream background — matches the canonical cream theme.
        dark: "#0E0E10",
        light: "#F5EFE6",
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
    <div className="mx-auto w-full max-w-page animate-fade-in p-7">
      <SettingsSubpageHeader
        stamp={t("Settings · Profile")}
        icon={<User size={18} strokeWidth={2} />}
        title={t("Profile")}
        sub={t(
          "Display name, bio, home region, units. Synced to the mobile app.",
        )}
      />

      {/* Profile form */}
      <Card padded={false} className="space-y-4 p-6">
        {/* Spec avatar hero row: 72 px circle + name/email/joined + `Change avatar` pill */}
        <div className="mb-2 flex items-center gap-[18px]">
          {previewAvatarUrl ? (
            // Browser-native <img>: avatar URLs come from arbitrary providers
            // (social login, etc.), so we'd need to enumerate every domain in
            // next.config.ts to use next/image — not practical here.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={previewAvatarUrl}
              alt={
                displayName
                  ? t("{name}'s profile photo", { name: displayName })
                  : t("Your profile photo")
              }
              className="h-[72px] w-[72px] rounded-full object-cover"
            />
          ) : (
            <div
              aria-hidden="true"
              className="flex h-[72px] w-[72px] items-center justify-center rounded-full bg-accent text-[28px] font-extrabold text-ink"
            >
              {displayName[0]?.toUpperCase() ?? "T"}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-[18px] font-extrabold text-ink">
              {displayName || t("Your profile")}
            </p>
            <p className="mt-0.5 truncate text-[12px] text-fg-dim">
              {user?.email}
              {joinedLabel ? ` · ${t("Joined")} ${joinedLabel}` : ""}
            </p>
          </div>
          <input
            ref={avatarFileInputRef}
            id="settings-avatar-file"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={handleAvatarFileChange}
            className="hidden"
            aria-hidden="true"
            tabIndex={-1}
          />
          <Button
            variant="secondary"
            uppercase
            loading={avatarUploadState === "uploading"}
            onClick={() => avatarFileInputRef.current?.click()}
          >
            {avatarUploadState === "uploading"
              ? t("Uploading…")
              : t("Change avatar")}
          </Button>
        </div>

        {avatarUploadState === "uploaded" && (
          <p
            role="status"
            aria-live="polite"
            className="text-[12px] text-accent"
          >
            {t("Photo uploaded.")}
          </p>
        )}
        {avatarUploadState === "error" && avatarUploadError && (
          <p
            role="alert"
            aria-live="assertive"
            className="text-[12px] text-red-400"
          >
            {avatarUploadError}
          </p>
        )}

        <div className="grid grid-cols-1 gap-[14px] md:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="settings-display-name"
              className="font-mono text-[10px] font-bold uppercase tracking-[1.5px] text-fg-dim"
            >
              {t("Display name")}
            </label>
            <input
              id="settings-display-name"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={100}
              className="rounded-lg border border-line bg-cream px-3 py-2.5 text-[13px] font-semibold text-ink transition focus:border-ink focus:outline-none"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="settings-home-region"
              className="font-mono text-[10px] font-bold uppercase tracking-[1.5px] text-fg-dim"
            >
              {t("Home region")}
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
              className="rounded-lg border border-line bg-cream px-3 py-2.5 text-[13px] font-semibold text-ink placeholder:text-fg-mute transition focus:border-ink focus:outline-none"
            />
          </div>
        </div>

        <div>
          <label
            htmlFor="settings-bio"
            className="mb-1.5 block font-mono text-[10px] font-bold uppercase tracking-[1.5px] text-fg-dim"
          >
            {t("Bio")}
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
              "A short blurb about your riding — shown on your public profile.",
            )}
            className="w-full resize-none rounded-lg border border-line bg-cream px-3 py-2.5 text-[13px] text-ink placeholder:text-fg-mute transition focus:border-ink focus:outline-none"
          />
          <p className="mt-1 font-mono text-xs text-fg-mute tabular-nums">
            {bio.length}/500
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-2">
          <Button
            variant="accent"
            uppercase
            loading={saveState === "saving"}
            onClick={handleSave}
          >
            {saveState === "saving" ? t("Saving…") : t("Save changes")}
          </Button>
          <Button
            variant="secondary"
            uppercase
            disabled={saveState === "saving"}
            onClick={handleCancel}
          >
            {t("Cancel")}
          </Button>
          {saveState === "saved" && (
            <span
              role="status"
              aria-live="polite"
              className="text-[13px] text-accent"
            >
              {t("Saved")}
            </span>
          )}
          {saveState === "error" && saveError && (
            <span
              role="alert"
              aria-live="assertive"
              className="text-[13px] text-red-400"
            >
              {saveError}
            </span>
          )}
        </div>
      </Card>

      <Card padded={false} className="mt-4 p-[22px]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <Stamp as="h2" className="mb-2 block">
              {t("Link mobile app")}
            </Stamp>
            <p className="text-sm text-fg-dim">
              {t(
                "Sign in on iPhone or Android with this same Tarmoto account to sync your rides, bikes, and profile details across devices. ",
              )}
            </p>
          </div>
          <div className="rounded-xl bg-paper p-3 text-accent">
            <Smartphone size={20} />
          </div>
        </div>
        <div className="mt-4 rounded-xl border border-line bg-paper p-4">
          <p className="text-sm text-ink">
            {t(
              "Scan the QR code or open Tarmoto on this phone to jump into mobile account linking, then sign in with the same credentials to keep everything in sync. ",
            )}
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-4">
            <div className="rounded-xl border border-line bg-cream p-3">
              {mobileLinkQrSrc ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={mobileLinkQrSrc}
                  alt={t("QR code to link the Tarmoto mobile app")}
                  className="h-36 w-36 rounded-lg"
                />
              ) : (
                <div className="flex h-36 w-36 items-center justify-center rounded-lg bg-paper-2 text-xs text-fg-dim">
                  {t("QR unavailable ")}
                </div>
              )}
            </div>
            <div className="max-w-sm space-y-3">
              <p className="text-xs text-fg-dim">
                {t(
                  "Best on another device: open your phone camera, scan the code, and Tarmoto will jump straight to account linking with your email prefilled. ",
                )}
              </p>
              {mobileLinkHref ? (
                <a
                  href={mobileLinkHref}
                  className="inline-flex items-center gap-2 rounded-full border border-accent bg-accent/10 px-4 py-[5px] text-[11px] font-bold uppercase tracking-[0.2px] text-accent transition hover:bg-accent/20"
                >
                  <Smartphone size={14} />
                  {t("Open in Tarmoto mobile ")}
                </a>
              ) : null}
            </div>
          </div>

          <Stamp className="mt-4 block">{t("Sign-in email ")}</Stamp>
          <p className="mt-1 break-all font-mono text-sm text-ink">
            {user?.email ?? t("No account email available")}
          </p>
          <div className="mt-4 flex items-center gap-3">
            <Button
              variant="secondary"
              size="sm"
              uppercase
              leftIcon={<Copy size={14} />}
              disabled={!user?.email}
              onClick={handleCopySignInEmail}
            >
              {t("Copy sign-in email ")}
            </Button>
            {copyState === "copied" && (
              <span role="status" className="text-sm text-accent">
                {t("Email copied. Use it to sign in on mobile. ")}
              </span>
            )}
            {copyState === "error" && (
              <span role="alert" className="text-sm text-red-400">
                {t("Could not copy your email. Please copy it manually. ")}
              </span>
            )}
          </div>
        </div>
      </Card>

      <Card padded={false} className="mt-4 p-[22px]">
        <Stamp as="h2" className="mb-2 block">
          {t("Display units")}
        </Stamp>
        <p className="mb-4 text-sm text-fg-dim">
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
          className="inline-flex rounded-lg bg-paper p-1"
        >
          {(["metric", "imperial"] as UnitSystem[]).map((value) => (
            <label
              key={value}
              className={`relative cursor-pointer rounded-md px-4 py-1.5 text-sm transition ${
                unitSystem === value
                  ? "bg-ink font-semibold text-cream"
                  : "text-fg-dim hover:text-ink"
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
                    ? t("Use metric units (kilometres)")
                    : t("Use imperial units (miles)")
                }
              />
              {value === "metric" ? t("Metric (km)") : t("Imperial (mi)")}
            </label>
          ))}
        </div>
      </Card>

      <Card padded={false} className="mt-4 p-[22px]">
        <Stamp as="h2" className="mb-2 block">
          {t("Language")}
        </Stamp>
        <p className="mb-4 text-sm text-fg-dim">
          {t("Pick the language used across the dashboard. ")}
        </p>
        <LocaleSwitcher />
      </Card>
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
