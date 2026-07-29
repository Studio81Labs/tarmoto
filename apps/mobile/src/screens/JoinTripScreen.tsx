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
import { Icon } from "@/components/Icon";
import {
  brandColorsLight,
  brandFonts,
  brandRadii,
  brandSpacing,
  statusFg,
} from "@/theme/brand";
import { api } from "@/services/api";
import type { TripsStackParamList } from "@/navigation/RootNavigator";
import { getUserFacingErrorMessage } from "@/i18n";
import { useTranslation } from "@/i18n/I18nProvider";
import { useFeatureKillSwitchActive } from "@/hooks/useFeatureKillSwitch";
import { isFeatureKillSwitchActive } from "@/services/systemSwitchCache";

type JoinRoute = RouteProp<TripsStackParamList, "TripJoin">;
type Nav = NativeStackNavigationProp<TripsStackParamList, "TripJoin">;

const t = brandColorsLight;

export default function JoinTripScreen() {
  const translate = useTranslation();
  const navigation = useNavigation<Nav>();
  const { params } = useRoute<JoinRoute>();

  // Operator kill switch (`trip_planning`): TripJoin is a planner destination
  // reachable directly via the `tarmoto://trips/join` deep link, so gate it
  // like the other planner screens — close on a kill and guard the join action.
  const tripPlanningEnabled = useFeatureKillSwitchActive("trip_planning");
  useEffect(() => {
    if (!tripPlanningEnabled) navigation.goBack();
  }, [tripPlanningEnabled, navigation]);

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
    // Planner killed while the form was open — bail before api.joinTrip.
    if (!isFeatureKillSwitchActive("trip_planning")) {
      navigation.goBack();
      return;
    }
    setSubmitting(true);
    setErrorMessage(null);
    try {
      await api.joinTrip(trimmedId, trimmedCode);
      // Replace rather than push: if the join started from TripsList, the
      // back target should be the list, not this form.
      navigation.replace("TripDetail", { tripId: trimmedId });
    } catch (err) {
      // This endpoint consumes an already-reserved personal invite — the
      // owner's max_trip_collaborators cap is enforced when the invite is
      // CREATED (or on the public share-link join), never here, so there's no
      // FEATURE_LIMIT_EXCEEDED to special-case. A bad/revoked code is a plain
      // 403 "Invalid trip or invite code".
      setErrorMessage(
        getUserFacingErrorMessage(err, translate("Unable to join trip")),
      );
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, trimmedId, trimmedCode, navigation, translate]);

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
            <Icon name="account-multiple-plus" size={28} color={t.fg} />
          </View>
          <Text style={styles.title}>{translate("Join a trip")}</Text>
          <Text style={styles.subtitle}>
            {translate(
              "Ask the trip owner for the trip ID and invite code. Once you join, you'll see the trip in your Trips list and share route updates with the rest of the group.",
            )}
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>{translate("Trip ID")}</Text>
          <TextInput
            style={styles.input}
            placeholder={translate("e.g. 8f3d0c1e-...")}
            placeholderTextColor={t.mute}
            value={tripId}
            onChangeText={setTripId}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="next"
          />

          <Text style={[styles.label, styles.labelSpacing]}>
            {translate("Invite code")}
          </Text>
          <TextInput
            style={styles.input}
            placeholder={translate("e.g. TARMOTO-42")}
            placeholderTextColor={t.mute}
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
            <Icon name="alert-circle" size={18} color={statusFg.danger} />
            <Text style={styles.errorText}>{errorMessage}</Text>
          </View>
        ) : null}

        <TouchableOpacity
          style={[styles.joinBtn, !canSubmit && styles.joinBtnDisabled]}
          onPress={handleJoin}
          disabled={!canSubmit}
          accessibilityRole="button"
          accessibilityState={{ disabled: !canSubmit, busy: submitting }}
          accessibilityLabel={translate("Join trip")}
        >
          {submitting ? (
            <ActivityIndicator color={t.invFg} />
          ) : (
            <>
              <Icon name="login-variant" size={20} color={t.invFg} />
              <Text style={styles.joinLabel}>{translate("Join trip")}</Text>
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
    backgroundColor: t.bg,
  },
  container: {
    flex: 1,
    backgroundColor: t.bg,
  },
  content: {
    padding: brandSpacing.s5,
    gap: brandSpacing.s4,
    paddingBottom: brandSpacing.s10,
  },
  hero: {
    gap: brandSpacing.s3,
  },
  heroIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: t.raised2,
  },
  title: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 28,
    fontWeight: "800",
    letterSpacing: -0.4,
  },
  subtitle: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    lineHeight: 22,
  },
  card: {
    backgroundColor: t.raised,
    borderRadius: brandRadii.md,
    borderWidth: 1,
    borderColor: t.line,
    padding: brandSpacing.s4,
    gap: brandSpacing.s3,
  },
  label: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "600",
  },
  labelSpacing: {
    marginTop: brandSpacing.s2,
  },
  input: {
    backgroundColor: t.sunken,
    borderWidth: 1,
    borderColor: t.line,
    color: t.fg,
    fontFamily: brandFonts.mono,
    borderRadius: brandRadii.sm,
    paddingHorizontal: brandSpacing.s4,
    paddingVertical: brandSpacing.s3,
    fontSize: 14,
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s2,
    padding: brandSpacing.s3,
    borderRadius: brandRadii.sm,
    borderWidth: 1,
    borderColor: statusFg.danger,
    backgroundColor: t.raised2,
  },
  errorText: {
    color: statusFg.danger,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    flex: 1,
  },
  joinBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: brandSpacing.s2,
    minHeight: 44,
    paddingVertical: brandSpacing.s4,
    borderRadius: brandRadii.pill,
    backgroundColor: t.invBg,
  },
  joinBtnDisabled: {
    opacity: 0.5,
  },
  joinLabel: {
    color: t.invFg,
    fontFamily: brandFonts.sans,
    fontSize: 16,
    fontWeight: "700",
  },
});
