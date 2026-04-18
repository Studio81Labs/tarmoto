/**
 * JoinTripScreen — US-8 invite-via-code entry point.
 *
 * Rider pastes the trip ID and invite code they received from the trip
 * owner, we POST to `/trips/:id/join`, then navigate to the detail screen
 * for the newly joined trip. Deep links can pre-fill both fields via
 * route params so a single tap on a shared link lands the rider one
 * button away from joining.
 *
 * The full real-time collaboration story (route sync, segment
 * suggestions, voting, chat — AC #2-#5 of US-8) is a follow-up: the
 * WebSocket gateway exists on the backend, but the collaboration event
 * contracts and map-overlay UI land in separate PRs.
 */

import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { RouteProp, useNavigation, useRoute } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import Icon from "@react-native-vector-icons/material-design-icons";
import { borderRadius, colors, fontSize, fontWeight, spacing } from "@/theme";
import { api } from "@/services/api";
import type { TripsStackParamList } from "@/navigation/RootNavigator";

type JoinRoute = RouteProp<TripsStackParamList, "TripJoin">;
type Nav = NativeStackNavigationProp<TripsStackParamList, "TripJoin">;

export default function JoinTripScreen() {
  const navigation = useNavigation<Nav>();
  const { params } = useRoute<JoinRoute>();

  const [tripId, setTripId] = useState(params?.tripId ?? "");
  const [inviteCode, setInviteCode] = useState(params?.inviteCode ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // If the rider navigates here from a deep link that already carries both
  // fields (e.g. a share URL), pre-fill without clobbering edits they've
  // started. `params` identity is stable per navigation event, so this
  // only fires when the deep link actually changes.
  useEffect(() => {
    if (params?.tripId) setTripId(params.tripId);
    if (params?.inviteCode) setInviteCode(params.inviteCode);
  }, [params?.tripId, params?.inviteCode]);

  const trimmedId = tripId.trim();
  const trimmedCode = inviteCode.trim();
  const canSubmit =
    trimmedId.length > 0 && trimmedCode.length > 0 && !submitting;

  const handleJoin = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      await api.joinTrip(trimmedId, trimmedCode);
      // Replace rather than push: if the join started from TripsList, the
      // back target should be the list, not this form.
      navigation.replace("TripDetail", { tripId: trimmedId });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unable to join trip";
      setErrorMessage(message);
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, trimmedId, trimmedCode, navigation]);

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.hero}>
          <View style={styles.heroIconWrap}>
            <Icon
              name="account-multiple-plus"
              size={28}
              color={colors.primary}
            />
          </View>
          <Text style={styles.title}>Join a trip</Text>
          <Text style={styles.subtitle}>
            Ask the trip owner for the trip ID and invite code. Once you join,
            you'll see the trip in your Trips list and share route updates with
            the rest of the group.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>Trip ID</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. 8f3d0c1e-..."
            placeholderTextColor={colors.textTertiary}
            value={tripId}
            onChangeText={setTripId}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="next"
          />

          <Text style={[styles.label, styles.labelSpacing]}>Invite code</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. TARMOTO-42"
            placeholderTextColor={colors.textTertiary}
            value={inviteCode}
            onChangeText={setInviteCode}
            autoCapitalize="characters"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={() => void handleJoin()}
          />
        </View>

        {errorMessage ? (
          <View style={styles.errorBanner}>
            <Icon name="alert-circle" size={18} color={colors.danger} />
            <Text style={styles.errorText}>{errorMessage}</Text>
          </View>
        ) : null}

        <TouchableOpacity
          style={[styles.joinBtn, !canSubmit && styles.joinBtnDisabled]}
          onPress={handleJoin}
          disabled={!canSubmit}
          accessibilityRole="button"
          accessibilityState={{ disabled: !canSubmit, busy: submitting }}
          accessibilityLabel="Join trip"
        >
          {submitting ? (
            <ActivityIndicator color={colors.textInverse} />
          ) : (
            <>
              <Icon name="login-variant" size={20} color={colors.textInverse} />
              <Text style={styles.joinLabel}>Join trip</Text>
            </>
          )}
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: spacing.xl,
    gap: spacing.lg,
    paddingBottom: spacing.section,
  },
  hero: {
    gap: spacing.md,
  },
  heroIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primaryAlpha15,
  },
  title: {
    color: colors.textPrimary,
    fontSize: fontSize.h1,
    fontWeight: fontWeight.bold,
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    lineHeight: 22,
  },
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
  },
  label: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  labelSpacing: {
    marginTop: spacing.sm,
  },
  input: {
    backgroundColor: colors.bgInput,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.textPrimary,
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    fontSize: fontSize.md,
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: "rgba(239, 68, 68, 0.08)",
  },
  errorText: {
    color: colors.danger,
    fontSize: fontSize.sm,
    flex: 1,
  },
  joinBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    paddingVertical: spacing.lg,
    borderRadius: borderRadius.pill,
    backgroundColor: colors.primary,
  },
  joinBtnDisabled: {
    opacity: 0.5,
  },
  joinLabel: {
    color: colors.textInverse,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
  },
});
