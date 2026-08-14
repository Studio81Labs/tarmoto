"use client";
import { CircleSlash } from "lucide-react";
import type { ReactNode } from "react";
import type { SystemFeatureKey } from "@tarmoto/shared";
import { Card } from "@tarmoto/ui";
import { useTranslation } from "@/i18n/I18nProvider";
import { useSystemSwitch } from "@/hooks/useEntitlements";

interface SystemSwitchGateProps {
  feature: SystemFeatureKey;
  children: ReactNode;
  /** Replaces the default notice. Pass `null` to render nothing when off. */
  fallback?: ReactNode;
}

/**
 * Hides a surface when an operator has disabled its `sys_*` subsystem.
 *
 * ## Why a sibling of `KillSwitchGate` rather than one generic component
 *
 * The two take DIFFERENT key types — `SystemFeatureKey` here,
 * `FreeToggleFeatureKey` there — and widening either to a union would let a
 * `sys_*` key be passed where a per-rider entitlement belongs and vice versa.
 * They resolve against different registry kinds, so that mistake compiles
 * cleanly and fails only at runtime, on an operator flip, which is the worst
 * possible time to discover it. Two components, two exact key types.
 *
 * ## Not an upsell
 *
 * Same reasoning as `KillSwitchGate`: a `sys_*` switch is an operator pausing
 * a subsystem, not a tier boundary. There is nothing to buy.
 *
 * ## Fails safe
 *
 * `useSystemSwitch` reports enabled until a `force_off` is CONFIRMED, so the
 * surface renders normally while the flag map is unresolved. A gate that
 * blanked on every cold load would cause more outage than it prevents.
 */
export function SystemSwitchGate({
  feature,
  children,
  fallback,
}: SystemSwitchGateProps) {
  const t = useTranslation();
  const { enabled } = useSystemSwitch(feature);

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
