"use client";
import Link from "next/link";
import { ErrorState } from "@tarmoto/ui";
import { useTranslation } from "@/i18n/I18nProvider";

/**
 * WHOLE-PAGE unavailable state for a killed feature or subsystem — the
 * "System state · OFF" screen, styled like the 404 rather than a strip of copy
 * at the top of an otherwise empty page.
 *
 * ## When to use this instead of the gates' default notice
 *
 * Only when the kill takes the ENTIRE route. `KillSwitchGate` and
 * `SystemSwitchGate` default to a small inline card because most of their call
 * sites remove one section of a working page — the badge shelf, the discover
 * feed, a challenge card — and a full-bleed maintenance screen would be a wild
 * over-reaction to a missing card.
 *
 * `/achievements` is the case that proves the distinction: `sys_gamification`
 * takes the badges and challenges but leaderboards stay live by design, so it
 * keeps the inline notice.
 *
 * ## Why `maintenance` / `OFF`
 *
 * An operator switch is a temporary, deliberate shutdown — not an error the
 * rider caused and not something a retry fixes. `forbidden` would blame them,
 * `server` would blame a fault, and both would be wrong.
 */
/**
 * Either the default pair, or BOTH overridden. A custom destination with the
 * default "Back to home" label is an accessible name that lies about where the
 * link goes — which is what shipped for the two trip routes before review.
 */
type FeatureUnavailablePageProps =
  | { backHref?: undefined; backLabel?: undefined }
  | {
      /** Where "back" should go — the nearest surface that still works. */
      backHref: string;
      /** Must name that destination; it is the link's accessible name. */
      backLabel: string;
    };

export function FeatureUnavailablePage({
  backHref,
  backLabel,
}: FeatureUnavailablePageProps) {
  const t = useTranslation();
  return (
    <ErrorState
      className="min-h-[70vh]"
      kind="maintenance"
      code="OFF"
      label={t("Unavailable")}
      title={t("This feature is paused")}
      body={t(
        "We've switched it off for a moment to keep things running. Nothing of yours has been deleted, and it will come back on its own.",
      )}
      actions={
        <Link
          href={backHref ?? "/"}
          className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-accent bg-accent px-4 py-[11px] text-[12.5px] font-bold uppercase tracking-[0.4px] text-ink transition hover:brightness-95"
        >
          {backLabel ?? t("Back to home")}
        </Link>
      }
    />
  );
}
