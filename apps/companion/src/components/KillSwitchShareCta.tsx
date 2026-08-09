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
 * The public share pages are SERVER components, and there is no server-side
 * read of the operator flag map yet (#1162). A stale legend on such a page is
 * cosmetic; a stale *link* is not — it is the page's single call to action, and
 * following it lands the visitor on the unavailable card with no explanation.
 * So rather than wait for that plumbing, the footer keeps its server rendering
 * and hands just the CTA to this island.
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
