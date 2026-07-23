"use client";
import { useRouter } from "next/navigation";
import {
  upgradeTierForFeature,
  upgradeTierForLimit,
  type LimitFeatureKey,
  type SubscriptionTier,
  type ToggleFeatureKey,
} from "@tarmoto/shared";
import { Button, Card, Heading } from "@tarmoto/ui";
import { useTranslation } from "@/i18n/I18nProvider";
import { tierLabel } from "@/lib/entitlements";

type UpgradeCapability =
  | { feature: ToggleFeatureKey }
  | { limit: LimitFeatureKey; resolvedLimit: number | null };

interface UpgradePromptProps {
  capability: UpgradeCapability;
  currentTier: SubscriptionTier;
  /** Already-localized contextual reason. */
  message: string;
  variant: "inline" | "modal";
  onClose?: () => void;
}

const SUBSCRIPTION_ROUTE = "/settings/subscription";

function resolveTarget(
  capability: UpgradeCapability,
  currentTier: SubscriptionTier,
): SubscriptionTier | null {
  return "feature" in capability
    ? upgradeTierForFeature(capability.feature, currentTier)
    : upgradeTierForLimit(
        capability.limit,
        currentTier,
        capability.resolvedLimit,
      );
}

export function UpgradePrompt({
  capability,
  currentTier,
  message,
  variant,
  onClose,
}: UpgradePromptProps) {
  const router = useRouter();
  const t = useTranslation();
  const target = resolveTarget(capability, currentTier);

  const cta =
    target === null ? null : (
      <Button
        variant="accent"
        size="sm"
        onClick={() => router.push(SUBSCRIPTION_ROUTE)}
      >
        {t("Upgrade to {tier}", { tier: tierLabel(target) })}
      </Button>
    );

  if (variant === "modal") {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-sm">
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t("Upgrade required")}
          className="w-full max-w-md rounded-[14px] border border-line bg-cream p-6"
        >
          <Heading size="md" as="h2">
            {t("Upgrade required")}
          </Heading>
          <p className="mt-2 text-[13px] text-ink/80">{message}</p>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>
              {t("Dismiss")}
            </Button>
            {cta}
          </div>
        </div>
      </div>
    );
  }

  return (
    <Card variant="ink" padded>
      <p className="text-[13px]">{message}</p>
      {cta ? <div className="mt-3">{cta}</div> : null}
    </Card>
  );
}
