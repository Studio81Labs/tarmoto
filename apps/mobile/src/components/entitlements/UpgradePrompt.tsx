/**
 * Upgrade / limit-reached modal — mobile port of
 * `apps/companion/src/components/entitlements/UpgradePrompt.tsx`.
 *
 * Mobile has no in-app purchase flow yet, so `onUpgrade` is an IAP seam:
 * when the caller omits it the CTA renders disabled with a "Coming soon"
 * hint rather than a dead-end purchase or a web billing deep-link. A future
 * IAP PR wires `onUpgrade` to the platform purchase flow.
 */
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import {
  upgradeTierForFeature,
  upgradeTierForLimit,
  type LimitFeatureKey,
  type SubscriptionTier,
  type ToggleFeatureKey,
} from "@tarmoto/shared";
import {
  brandColorsLight,
  brandFonts,
  brandRadii,
  brandSpacing,
} from "@/theme/brand";
import { useTranslation } from "@/i18n/I18nProvider";
import { tierLabel } from "@/lib/entitlements";

const t = brandColorsLight;

type UpgradeCapability =
  | { feature: ToggleFeatureKey }
  | { limit: LimitFeatureKey; resolvedLimit: number | null };

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

export interface UpgradePromptProps {
  visible: boolean;
  capability: UpgradeCapability;
  currentTier: SubscriptionTier;
  /** Already-localized contextual reason, shown when an upgrade CAN lift the
   *  restriction (there's a higher tier to move to). */
  message: string;
  /** Already-localized copy shown INSTEAD of `message` when no upgrade can
   *  restore access (top tier, or an operator override/force-off) — so a
   *  rider who can't upgrade isn't told to. Falls back to `message` when
   *  omitted. */
  neutralMessage?: string;
  onClose: () => void;
  /** IAP purchase seam — informational ("Coming soon") when absent. */
  onUpgrade?: () => void;
  /** Force the neutral, no-CTA state even if the caller's tier has an
   *  upgrade target — e.g. an owner-scoped cap hit by a collaborator, where
   *  upgrading the CALLER's plan can't lift the OWNER's limit. */
  suppressUpgrade?: boolean;
}

export function UpgradePrompt({
  visible,
  capability,
  currentTier,
  message,
  neutralMessage,
  onClose,
  onUpgrade,
  suppressUpgrade = false,
}: UpgradePromptProps) {
  const translate = useTranslation();
  const target = suppressUpgrade
    ? null
    : resolveTarget(capability, currentTier);

  // With no higher tier to offer (an override-clamped cap, or already the
  // top tier) an upgrade can't lift the restriction — title the modal
  // neutrally instead of pointing the rider at a CTA that won't help.
  const title =
    target === null
      ? translate("Limit reached")
      : translate("Upgrade required");
  // Likewise swap the body to neutral copy when there's nothing to upgrade to,
  // so we don't tell a rider who can't upgrade to upgrade.
  const shownMessage =
    target === null && neutralMessage ? neutralMessage : message;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <View
          accessibilityRole="none"
          accessibilityViewIsModal
          accessibilityLabel={title}
          style={styles.card}
        >
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.message}>{shownMessage}</Text>
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={translate("Dismiss")}
              onPress={onClose}
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryButtonLabel}>
                {translate("Dismiss")}
              </Text>
            </Pressable>
            {target !== null ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={translate("Upgrade to {tier}", {
                  tier: tierLabel(target, translate),
                })}
                accessibilityState={{ disabled: !onUpgrade }}
                onPress={onUpgrade}
                disabled={!onUpgrade}
                style={[
                  styles.primaryButton,
                  !onUpgrade && styles.primaryButtonDisabled,
                ]}
              >
                <Text style={styles.primaryButtonLabel}>
                  {translate("Upgrade to {tier}", {
                    tier: tierLabel(target, translate),
                  })}
                </Text>
              </Pressable>
            ) : null}
          </View>
          {target !== null && !onUpgrade ? (
            <Text style={styles.comingSoonHint}>
              {translate("Coming soon")}
            </Text>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(14,14,16,0.4)",
    padding: brandSpacing.s4,
  },
  card: {
    width: "100%",
    maxWidth: 420,
    borderRadius: brandRadii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.line,
    backgroundColor: t.bg,
    padding: brandSpacing.s6,
  },
  title: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 18,
    fontWeight: "700",
  },
  message: {
    marginTop: brandSpacing.s2,
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
  },
  actions: {
    marginTop: brandSpacing.s5,
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: brandSpacing.s2,
  },
  secondaryButton: {
    paddingHorizontal: brandSpacing.s4,
    minHeight: 40,
    borderRadius: brandRadii.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: t.raised2,
  },
  secondaryButtonLabel: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    fontWeight: "600",
  },
  primaryButton: {
    paddingHorizontal: brandSpacing.s4,
    minHeight: 40,
    borderRadius: brandRadii.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: t.invBg,
  },
  primaryButtonDisabled: {
    opacity: 0.5,
  },
  primaryButtonLabel: {
    color: t.invFg,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    fontWeight: "700",
  },
  comingSoonHint: {
    marginTop: brandSpacing.s2,
    textAlign: "right",
    color: t.mute,
    fontFamily: brandFonts.sans,
    fontSize: 11,
  },
});
