"use client";
import { CircleSlash } from "lucide-react";
import type { ReactNode } from "react";
import type { FreeToggleFeatureKey } from "@tarmoto/shared";
import { Card } from "@tarmoto/ui";
import { useTranslation } from "@/i18n/I18nProvider";
import { useFeatureKillSwitch } from "@/hooks/useEntitlements";

interface KillSwitchGateProps {
  feature: FreeToggleFeatureKey;
  children: ReactNode;
  /** Replaces the default notice. Pass `null` to render nothing when killed. */
  fallback?: ReactNode;
}

/**
 * Hides a surface when an operator has killed its feature.
 *
 * ## Not an upsell
 *
 * Deliberately NOT `LockedFeatureCard`. That one offers an upgrade, which is the
 * right answer for a tier gate and the wrong one here: an operator kill switch
 * is not something a rider can buy past, and showing them a purchase CTA for a
 * feature no amount of money will unlock is worse than showing nothing. The copy
 * says "temporarily unavailable" and offers no action, because there is none.
 *
 * ## Fails safe
 *
 * `useFeatureKillSwitch` reports enabled until a `force_off` is confirmed, so
 * the surface renders normally while the flag map is unresolved. A kill switch
 * that blanked the page on every load — or on a slow network — would cause more
 * outage than it prevents.
 */
export function KillSwitchGate({
  feature,
  children,
  fallback,
}: KillSwitchGateProps) {
  const t = useTranslation();
  const { enabled } = useFeatureKillSwitch(feature);

  if (enabled) return <>{children}</>;
  if (fallback !== undefined) return <>{fallback}</>;

  return (
    <Card className="flex items-center gap-3">
      <CircleSlash size={16} className="text-fg-dim" aria-hidden />
      <p className="text-sm text-fg-dim">
        {t("This feature is temporarily unavailable. Please try again later.")}
      </p>
    </Card>
  );
}
