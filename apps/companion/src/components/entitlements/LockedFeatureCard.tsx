"use client";
import { Lock } from "lucide-react";
import { Card, Stamp } from "@tarmoto/ui";
import type { SubscriptionTier } from "@tarmoto/shared";
import { UpgradePrompt } from "./UpgradePrompt";

interface LockedFeatureCardProps {
  /** Mono eyebrow, matching the real section's `Stamp` (e.g. "Elevation profile"). */
  stamp: string;
  /** Section heading, matching the real section's title (e.g. "Climb & descent"). */
  title: string;
  /** Feature-specific, already-localized reason shown in the teaser body. */
  message: string;
  /** `null` while the entitlement snapshot hasn't resolved yet — the CTA
   *  needs a known tier to compute an upgrade target, so it's omitted until
   *  then (the locked message still renders — fail-closed, never blank). */
  currentTier: SubscriptionTier | null;
  className?: string;
}

/**
 * Locked teaser variant of a stat `Card` — replaces a Pro-only section's real
 * content (elevation profile, lean distribution) with a lock affordance +
 * upsell, keeping the section's header so the page never shows an
 * unexplained gap where a card used to be.
 */
export function LockedFeatureCard({
  stamp,
  title,
  message,
  currentTier,
  className,
}: LockedFeatureCardProps) {
  return (
    <Card className={className}>
      <div className="flex items-center gap-2">
        <Stamp>{stamp}</Stamp>
        <Lock size={12} className="text-fg-mute" aria-hidden />
      </div>
      <div className="mt-1 text-[18px] font-extrabold leading-[1.05] tracking-[-0.5px] text-ink">
        {title}
      </div>
      <div className="mt-4">
        {currentTier ? (
          <UpgradePrompt
            variant="inline"
            capability={{ feature: "advanced_ride_stats" }}
            currentTier={currentTier}
            message={message}
          />
        ) : (
          <p className="text-[13px] text-fg-dim">{message}</p>
        )}
      </div>
    </Card>
  );
}
