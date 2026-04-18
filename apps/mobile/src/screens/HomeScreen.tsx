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
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { borderRadius, colors, fontSize, fontWeight, spacing } from "@/theme";
import type { HomeStackParamList } from "@/navigation/RootNavigator";

type HomeNav = NativeStackNavigationProp<HomeStackParamList, "Home">;

export default function HomeScreen() {
  const navigation = useNavigation<HomeNav>();

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Tarmoto</Text>
        <Text style={styles.subtitle}>Know the road before you ride it.</Text>

        <TouchableOpacity
          style={styles.card}
          onPress={() => navigation.navigate("Commute")}
          accessibilityRole="button"
          accessibilityLabel="Open commute hazard check"
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
});
