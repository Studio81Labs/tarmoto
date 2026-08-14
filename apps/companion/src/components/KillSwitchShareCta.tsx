"use client";

import type { ReactNode } from "react";
import type { FreeToggleFeatureKey } from "@tarmoto/shared";
import { useFeatureKillSwitch } from "@/hooks/useEntitlements";
import { ShareCtaLink } from "@/components/public-share";

/**
 * A public-share footer CTA that disappears when its destination is killed.
 *
 * ## Why this exists as a client island
 *
 * The public share pages are SERVER components, so their HTML is fixed at
 * request time. `serverKillSwitch` now resolves the flag map there too, and
 * the share routes gate themselves on it — but that only covers visitors who
 * arrive AFTER the operator flips the switch. This island re-reads the flag on
 * the polling client, so a page already open in a tab drops its CTA rather
 * than leaving a live link into a killed surface. Defence in depth, and the
 * only layer that reaches an already-served page.
 *
 * Renders nothing when killed: there is no honest alternative action to offer,
 * and the footer reads fine without it.
 */
export function KillSwitchShareCta({
  feature,
  href,
  label,
  icon,
}: {
  feature: FreeToggleFeatureKey;
  href: string;
  label: string;
  icon: ReactNode;
}) {
  const { enabled } = useFeatureKillSwitch(feature);
  if (!enabled) return null;
  return (
    <ShareCtaLink href={href} variant="ink" icon={icon}>
      {label}
    </ShareCtaLink>
  );
}
