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
import { useSystemSwitch, useUpgradeRouting } from "@/hooks";
import { useTranslation } from "@/i18n/I18nProvider";
import { tierLabel } from "@/lib/entitlements";

export type UpgradeCapability =
  | { feature: ToggleFeatureKey }
  | { limit: LimitFeatureKey; resolvedLimit: number | null };

interface UpgradePromptProps {
  capability: UpgradeCapability;
  currentTier: SubscriptionTier;
  /** Already-localized contextual reason. */
  message: string;
  variant: "inline" | "modal";
  onClose?: () => void;
  /** Force the neutral, no-CTA state even if the caller's tier has an upgrade
   *  target — e.g. an owner-scoped cap hit by a collaborator, where upgrading
   *  the CALLER's plan can't lift the OWNER's limit. */
  suppressUpgrade?: boolean;
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
  suppressUpgrade = false,
}: UpgradePromptProps) {
  const router = useRouter();
  const t = useTranslation();
  // An operator kill of Stripe Checkout leaves the billing page unable to
  // start a NEW subscription, so sending a rider whose upgrade routes through
  // Checkout there is a dead end — drop the CTA and let the prompt state the
  // limit plainly. Riders who change plan through the portal or a store keep
  // theirs: the switch leaves those paths open on purpose, and blanking their
  // CTA would strand them for a failure that isn't theirs. An UNRESOLVED
  // switch (fail-safe: enabled) or routing answer keeps the CTA too.
  const { enabled: checkoutEnabled } = useSystemSwitch("sys_billing_checkout");
  const { needsCheckout } = useUpgradeRouting();
  const checkoutBlocked = !checkoutEnabled && needsCheckout;
  // The target a rider WOULD be offered if Checkout were live. Split out so the
  // outage note below can ask the only question that matters — did the kill
  // remove a CTA that would otherwise exist — rather than inferring it from an
  // absent one, which has other causes.
  const potentialTarget = suppressUpgrade
    ? null
    : resolveTarget(capability, currentTier);
  const target = checkoutBlocked ? null : potentialTarget;

  // With no higher tier to offer (an override-clamped cap, or already the top
  // tier) a paid upgrade can't lift the restriction — title the modal neutrally
  // instead of pointing the rider at a billing action that won't help.
  const modalTitle =
    target === null ? t("Limit reached") : t("Upgrade required");

  // `target === null` has three causes and they are not interchangeable: the
  // caller suppressed the upsell, the rider has no higher tier to buy, or an
  // operator killed Checkout. Only the last one is TEMPORARY, and only it
  // leaves a rider looking at copy that names a paid tier with no way to reach
  // it — so it gets a reason. Saying "temporarily unavailable" for the other
  // two would be false.
  // `potentialTarget` is what keeps this honest. A caller that suppresses the
  // upsell has decided upgrading is not the answer at all — the non-owner
  // editor in `TripCollaborateModal` cannot raise the OWNER's limit by buying
  // anything — so telling them upgrades are "temporarily unavailable" would
  // point at a door that was never theirs.
  const blockedNote =
    checkoutBlocked && potentialTarget !== null ? (
      <p className="mt-2 text-[13px] text-ink/60">
        {t("Upgrades are temporarily unavailable. Please try again later.")}
      </p>
    ) : null;

  const cta =
    target === null ? null : (
      <Button
        variant="accent"
        size="sm"
        onClick={() => router.push(SUBSCRIPTION_ROUTE)}
      >
        {t("Upgrade to {tier}", { tier: t(tierLabel(target)) })}
      </Button>
    );

  if (variant === "modal") {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-sm">
        <div
          role="dialog"
          aria-modal="true"
          aria-label={modalTitle}
          className="w-full max-w-md rounded-[14px] border border-line bg-cream p-6"
        >
          <Heading size="md" as="h2">
            {modalTitle}
          </Heading>
          <p className="mt-2 text-[13px] text-ink/80">{message}</p>
          {blockedNote}
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
      {blockedNote}
      {cta ? <div className="mt-3">{cta}</div> : null}
    </Card>
  );
}
