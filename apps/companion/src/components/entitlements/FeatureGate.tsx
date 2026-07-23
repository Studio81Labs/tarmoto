"use client";
import type { ReactNode } from "react";
import type { ToggleFeatureKey } from "@tarmoto/shared";
import { useEntitlements, useFeature } from "@/hooks";
import { useTranslation } from "@/i18n/I18nProvider";
import { UpgradePrompt } from "./UpgradePrompt";

interface FeatureGateProps {
  feature: ToggleFeatureKey;
  children: ReactNode;
  /** Rendered while entitlements load — default null (no locked-state flash). */
  loadingFallback?: ReactNode;
}

export function FeatureGate({
  feature,
  children,
  loadingFallback = null,
}: FeatureGateProps) {
  const { enabled, isLoading } = useFeature(feature);
  const { tier } = useEntitlements();
  const t = useTranslation();

  if (isLoading || !tier) return <>{loadingFallback}</>;
  if (enabled) return <>{children}</>;

  return (
    <UpgradePrompt
      variant="inline"
      capability={{ feature }}
      currentTier={tier}
      message={t("This feature isn't on your plan.")}
    />
  );
}
