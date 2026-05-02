import React from "react";
import {
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import Icon from "@react-native-vector-icons/material-design-icons";
import {
  type CompositeNavigationProp,
  useNavigation,
} from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import { borderRadius, colors, fontSize, fontWeight, spacing } from "@/theme";
import { useCommute } from "@/hooks/useCommute";
import type {
  HomeStackParamList,
  RootTabParamList,
} from "@/navigation/RootNavigator";

// Composite type covers the in-stack `Commute` push AND the cross-tab
// jump into RideTab → RideActive that the US-21 "Start commute" CTA
// performs. Without the tab navigator's typing, `navigate("RideTab", ...)`
// wouldn't typecheck.
type HomeNav = CompositeNavigationProp<
  NativeStackNavigationProp<HomeStackParamList, "Home">,
  BottomTabNavigationProp<RootTabParamList>
>;

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
        <Text style={styles.title}>Tarmoto</Text>
        <Text style={styles.subtitle}>Know the road before you ride it.</Text>

        {canStartCommute ? (
          <TouchableOpacity
            style={styles.startCard}
            onPress={handleStartCommute}
            accessibilityRole="button"
            accessibilityLabel={`Start commute to ${route.name}`}
          >
            <View style={styles.startIcon}>
              <Icon name="play-circle" size={24} color={colors.textInverse} />
            </View>
            <View style={styles.cardBody}>
              <Text style={styles.startTitle}>Start commute</Text>
              <Text style={styles.startBody}>
                {route.name}
                {route.distance_km != null
                  ? ` · ${route.distance_km.toFixed(1)} km`
                  : ""}
              </Text>
            </View>
            <Icon
              name="chevron-right"
              size={22}
              color={colors.textInverse}
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
              ? `Open commute hazard check. ${displayCount} new ${
                  newHazardCount === 1 ? "hazard" : "hazards"
                } since your last check.`
              : "Open commute hazard check"
          }
        >
          <View style={styles.cardIcon}>
            <Icon name="map-marker-path" size={22} color={colors.primary} />
          </View>
          <View style={styles.cardBody}>
            <Text style={styles.cardTitle}>Commute check</Text>
            <Text style={styles.cardBodyText}>
              See active hazards and weather on your regular route.
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
              <Text style={styles.newBadgeText}>{displayCount} NEW</Text>
            </View>
          ) : null}
          <Icon name="chevron-right" size={22} color={colors.textTertiary} />
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: spacing.xl,
    gap: spacing.lg,
  },
  title: {
    color: colors.textPrimary,
    fontSize: fontSize.h1,
    fontWeight: fontWeight.bold,
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.lg,
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  startCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.lg,
    backgroundColor: colors.primary,
    borderRadius: borderRadius.lg,
  },
  startIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    alignItems: "center",
    justifyContent: "center",
  },
  startTitle: {
    color: colors.textInverse,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
  },
  startBody: {
    color: colors.textInverse,
    fontSize: fontSize.sm,
    opacity: 0.85,
  },
  cardIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.primaryAlpha15,
    alignItems: "center",
    justifyContent: "center",
  },
  cardBody: {
    flex: 1,
    gap: 2,
  },
  cardTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
  },
  cardBodyText: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  newBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: borderRadius.pill,
    backgroundColor: colors.danger,
  },
  newBadgeText: {
    color: colors.white,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
    letterSpacing: 0.4,
  },
});
