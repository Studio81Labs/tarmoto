import React from "react";
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Icon } from "@/components/Icon";
import {
  type CompositeNavigationProp,
  useNavigation,
} from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import {
  brandColorsLight,
  brandFonts,
  brandRadii,
  brandSpacing,
  statusFg,
} from "@/theme/brand";
import { useCommute } from "@/hooks/useCommute";
import type {
  HomeStackParamList,
  RootTabParamList,
} from "@/navigation/RootNavigator";
import { t as translate } from "@/i18n";

// Composite type covers the in-stack `Commute` push AND the cross-tab
// jump into RideTab → RideActive that the US-21 "Start commute" CTA
// performs. Without the tab navigator's typing, `navigate("RideTab", ...)`
// wouldn't typecheck.
type HomeNav = CompositeNavigationProp<
  NativeStackNavigationProp<HomeStackParamList, "Home">,
  BottomTabNavigationProp<RootTabParamList>
>;

const t = brandColorsLight;

export default function HomeScreen() {
  const navigation = useNavigation<HomeNav>();
  // US-15 AC #3: surface the hazard diff at the app entry point so a rider
  // who lands on Home before opening the Commute tab can still see at a
  // glance that their regular route has unseen hazards. The badge clears
  // the moment they open CommuteScreen and tap "Mark all seen" — same
  // acknowledge flow that drives the in-list NEW markers.
  //
  // `withSecondary: false` keeps the cold-start request count down to
  // routes + status — HomeScreen never renders alternatives or weekly
  // stats, so the extra two requests would be pure waste.
  const { phase, route, newHazardCount } = useCommute({ withSecondary: false });
  const showBadge = phase === "ready" && newHazardCount > 0;
  // Cap the displayed count at 99+ so the badge stays visually compact,
  // and reuse the same string in the accessibility label so VoiceOver
  // announces the same value a sighted rider sees.
  const displayCount = newHazardCount > 99 ? "99+" : String(newHazardCount);

  // US-21 AC #1: only surface the one-tap CTA when there's actually a
  // primary commute saved. The hook reports `phase === "learning"`
  // until the user has saved a route, which is also when the
  // CommuteScreen shows its onboarding state.
  const canStartCommute = phase === "ready" && route !== null;

  const handleStartCommute = (): void => {
    // Cross-tab nav: switches the active tab to Ride and lands the rider
    // on the live HUD. RideActiveScreen handles the actual `/rides/start`
    // POST + telemetry from `params.rideType`.
    navigation.navigate("RideTab", {
      screen: "RideActive",
      params: { rideType: "commute" },
    });
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>{translate("Tarmoto")}</Text>
        <Text style={styles.subtitle}>
          {translate("Know the road before you ride it.")}
        </Text>

        {canStartCommute ? (
          <TouchableOpacity
            style={styles.startCard}
            onPress={handleStartCommute}
            accessibilityRole="button"
            accessibilityLabel={translate("Start commute to {value0}", {
              value0: route.name,
            })}
          >
            <View style={styles.startIcon}>
              <Icon name="play-circle" size={24} color={t.invFg} />
            </View>
            <View style={styles.cardBody}>
              <Text style={styles.startTitle}>
                {translate("Start commute")}
              </Text>
              <Text style={styles.startBody}>
                {route.distance_km != null
                  ? translate("{name} · {distance} km", {
                      name: route.name,
                      distance: route.distance_km.toFixed(1),
                    })
                  : route.name}
              </Text>
            </View>
            <Icon
              name="chevron-right"
              size={22}
              color={t.invFg}
              accessibilityElementsHidden
            />
          </TouchableOpacity>
        ) : null}

        <TouchableOpacity
          style={styles.card}
          onPress={() => navigation.navigate("Commute")}
          accessibilityRole="button"
          accessibilityLabel={
            showBadge
              ? translate(
                  "Open commute hazard check. {count, plural, one {{displayCount} new hazard} other {{displayCount} new hazards}} since your last check.",
                  {
                    count: newHazardCount,
                    displayCount,
                  },
                )
              : translate("Open commute hazard check")
          }
        >
          <View style={styles.cardIcon}>
            <Icon name="map-marker-path" size={22} color={t.accent} />
          </View>
          <View style={styles.cardBody}>
            <Text style={styles.cardTitle}>{translate("Commute check")}</Text>
            <Text style={styles.cardBodyText}>
              {translate(
                "See active hazards and weather on your regular route.",
              )}
            </Text>
          </View>
          {showBadge ? (
            <View
              style={styles.newBadge}
              // Hide from a11y: the count is already part of the card's
              // accessibilityLabel above, so an extra node would make
              // VoiceOver read the number twice.
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              <Text style={styles.newBadgeText}>
                {translate("{count} NEW", { count: displayCount })}
              </Text>
            </View>
          ) : null}
          <Icon name="chevron-right" size={22} color={t.faint} />
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: t.bg,
  },
  content: {
    padding: brandSpacing.s5,
    gap: brandSpacing.s4,
  },
  title: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 32,
    fontWeight: "800",
  },
  subtitle: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 14,
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s3,
    padding: brandSpacing.s4,
    minHeight: 64,
    backgroundColor: t.raised,
    borderRadius: brandRadii.md,
    borderWidth: 1,
    borderColor: t.line,
  },
  // The one-tap hero CTA reads as a solid ink card (primary-action pattern,
  // matching the migrated Profile / RideDetail buttons) so the accent stays
  // reserved for small marks (<5% of pixels).
  startCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s3,
    padding: brandSpacing.s4,
    minHeight: 64,
    backgroundColor: t.invBg,
    borderRadius: brandRadii.md,
  },
  startIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    // Cream tint on the ink card so the play glyph sits in a subtle disc.
    backgroundColor: "rgba(245, 239, 230, 0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  startTitle: {
    color: t.invFg,
    fontFamily: brandFonts.sans,
    fontSize: 16,
    fontWeight: "700",
  },
  startBody: {
    color: t.invFg,
    fontFamily: brandFonts.sans,
    fontSize: 12,
    opacity: 0.85,
  },
  cardIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: t.raised2,
    alignItems: "center",
    justifyContent: "center",
  },
  cardBody: {
    flex: 1,
    gap: 2,
  },
  cardTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 16,
    fontWeight: "600",
  },
  cardBodyText: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 12,
  },
  newBadge: {
    paddingHorizontal: brandSpacing.s2,
    paddingVertical: 2,
    borderRadius: brandRadii.pill,
    backgroundColor: statusFg.danger,
  },
  newBadgeText: {
    // White on the dark danger red clears AA (~6:1) for this small label.
    color: "#FFFFFF",
    fontFamily: brandFonts.sans,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.4,
  },
});
