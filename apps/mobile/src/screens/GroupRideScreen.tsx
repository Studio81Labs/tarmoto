/**
 * GroupRideScreen — US-26 real-time group ride live location sharing.
 *
 * Two-state screen:
 *
 *   - "idle" — no active group ride. Rider can either create a new
 *     session (gets back a 6-char code to share) or join an existing
 *     one by entering a code.
 *   - "active" — connected to a group ride. Live map shows other
 *     members as colored dots; the rider's own position is published
 *     to the room at the server-enforced 1 Hz floor while a regular
 *     ride is active. Member list under the map surfaces speed and
 *     last-seen timestamp so a stragglers can still locate the group
 *     when the dot is offscreen.
 *
 * Live channel is `groupRideSocket`; REST surface is `api.*GroupRide`.
 * Privacy AC: leave deletes the membership row immediately on the
 * server, which removes the rider's last-known position from every
 * other member's GET response on the next poll. We unmount on leave
 * so a stale socket can't keep broadcasting.
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import {
  Camera,
  GeoJSONSource,
  Layer,
  Map,
} from "@maplibre/maplibre-react-native";
import { Icon } from "@/components/Icon";
import {
  brandColorsLight,
  brandFonts,
  brandRadii,
  brandSpacing,
  statusFg,
} from "@/theme/brand";
import { ApiError, api } from "@/services/api";
import { groupRideSocket } from "@/services/groupRideSocket";
import { APP_MAP_STYLE_URL } from "./MapScreen.helpers";
import { resolveGroupRideError } from "./GroupRideScreen.helpers";
import { formatSpeedKmh } from "./RideScreens.helpers";
import { useAuthStore, useRideStore } from "@/stores";
import { useEntitlements, useFeature } from "@/hooks/useEntitlements";
import { UpgradePrompt } from "@/components/entitlements/UpgradePrompt";
import {
  FEATURE_LIMIT_EXCEEDED,
  upgradeTierForFeature,
  type SubscriptionTier,
} from "@tarmoto/shared";
import type {
  GroupEndedEvent,
  GroupJoinedEvent,
  GroupLeftEvent,
  GroupPositionEvent,
  GroupRideDetail,
  GroupRideMember,
} from "@/types";
import { getUserFacingErrorMessage } from "@/i18n";
import { useTranslation } from "@/i18n/I18nProvider";

// Distinct map-pin colours so each member's dot is visually
// distinguishable. Cycled by member position in the sorted list so
// the assignment is deterministic per render — the dots don't
// "swap colours" on every position update.
const MEMBER_COLORS = [
  "#3b82f6",
  "#ef4444",
  "#10b981",
  "#f59e0b",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#f97316",
];

type Mode = "idle" | "active";

const t = brandColorsLight;

function uppercaseGroupRideCode(value: string): string {
  // eslint-disable-next-line tarmoto-localization/no-locale-insensitive-search -- Group ride codes are invariant six-character protocol tokens, not rider-facing language.
  return value.toUpperCase();
}

/**
 * True when a 403 is the `max_group_ride_members` CAP rejection (a full
 * ride, backend `featureLimitExceeded` body carries `code:
 * FEATURE_LIMIT_EXCEEDED`) rather than a `group_rides` entitlement denial.
 * The cap is the OWNER's limit — the joiner can't lift it by upgrading — so
 * this must surface a "ride is full" message, not the group_rides upsell.
 */
function isGroupMemberCapError(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 403) return false;
  const body = err.body;
  if (typeof body !== "object" || body === null) return false;
  return (body as Record<string, unknown>).code === FEATURE_LIMIT_EXCEEDED;
}

export default function GroupRideScreen() {
  const translate = useTranslation();
  const [mode, setMode] = useState<Mode>("idle");
  const [groupRide, setGroupRide] = useState<GroupRideDetail | null>(null);
  const [name, setName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // #M2: group_rides is a Premium toggle. The idle create/join UI is
  // gated below (an already-`active` session stays reachable regardless
  // of entitlement — see the mode branch), and `handleCreate`/`handleJoin`
  // both guard proactively + fall back to this same modal on a reactive
  // 403 (stale snapshot, revoked mid-session).
  const { enabled: groupRidesEnabled, isResolved: groupRidesResolved } =
    useFeature("group_rides");
  const { tier } = useEntitlements();
  const [upgradeVisible, setUpgradeVisible] = useState(false);

  // Live position overlay keyed by user_id. Seeded from the GET
  // response, then updated in place by `group:position` socket events.
  // Held in a ref so the position handler doesn't re-render the whole
  // screen on every tick — the map source reads from a separate state
  // slot that we batch-update on a frame timer.
  const positionsRef = useRef<Record<string, GroupRideMember>>({});
  const [positionTick, setPositionTick] = useState(0);

  // Subscribe the rider's own location updates into the socket while
  // the screen is mounted AND the rider is on an active ride. Without
  // the active-ride guard, the screen would keep publishing zeros if
  // the user opened it before tapping Start.
  const myLocation = useRideStore((s) => s.location);
  const isRiding = useRideStore((s) => s.isRiding);
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);

  // ── Hydrate the position map from the GET response ──
  useEffect(() => {
    if (!groupRide) return;
    const seeded: Record<string, GroupRideMember> = {};
    for (const m of groupRide.members) {
      seeded[m.user_id] = m;
    }
    positionsRef.current = seeded;
    setPositionTick((t) => t + 1);
  }, [groupRide]);

  // ── Wire socket once we enter active mode ──
  useEffect(() => {
    if (mode !== "active" || !groupRide) return;

    const handlePosition = (event: GroupPositionEvent): void => {
      const existing = positionsRef.current[event.user_id];
      // Display name is not in the position payload — preserve it from
      // the seeded copy, or fall back to the user_id if a fresh joiner
      // shows up before we've refetched detail.
      positionsRef.current[event.user_id] = {
        user_id: event.user_id,
        display_name: existing?.display_name ?? event.user_id.slice(0, 8),
        joined_at: existing?.joined_at ?? event.at,
        last_lat: event.lat,
        last_lng: event.lng,
        last_speed: event.speed,
        last_heading: event.heading,
        last_position_at: event.at,
        recent_path: existing?.recent_path ?? [],
      };
      setPositionTick((t) => t + 1);
    };

    const handleJoined = (event: GroupJoinedEvent): void => {
      // Refetch detail to pick up display name and any positions the
      // joiner had cached server-side. Falling back to a synthetic
      // placeholder would leave the dot label blank until they moved.
      api
        .getGroupRide(groupRide.id)
        .then(setGroupRide)
        .catch(() => undefined);
      Alert.alert(
        translate("Group ride"),
        translate("{value0} joined.", { value0: event.display_name }),
      );
    };

    const handleLeft = (event: GroupLeftEvent): void => {
      delete positionsRef.current[event.user_id];
      setPositionTick((t) => t + 1);
      api
        .getGroupRide(groupRide.id)
        .then(setGroupRide)
        .catch(() => undefined);
    };

    const teardownToIdle = (): void => {
      groupRideSocket.disconnect();
      setMode("idle");
      setGroupRide(null);
      // Wipe any in-session error banner so a transient throttle/network
      // complaint from the active state doesn't bleed into the idle
      // create-or-join UI and look like the form itself is broken.
      setErrorMessage(null);
      positionsRef.current = {};
    };

    const handleEnded = (_: GroupEndedEvent): void => {
      Alert.alert(
        translate("Group ride ended"),
        translate("The owner ended the ride."),
      );
      teardownToIdle();
    };

    // Some failure modes from the gateway are terminal for this
    // session — the room is gone or the rider is no longer welcome —
    // and leaving the rider on a stuck "active" screen with just an
    // error banner means they have to tap Leave to recover. Detect
    // those messages and run the same teardown as `handleEnded`.
    // Anything else (transient network blip, throttle complaint) is surfaced
    // through cataloged generic copy without exposing gateway diagnostics.
    const handleError = (msg: string): void => {
      const error = resolveGroupRideError(msg);
      if (error.terminal) {
        Alert.alert(translate("Group ride"), error.displayText);
        teardownToIdle();
        return;
      }
      setErrorMessage(error.displayText);
    };

    groupRideSocket.connect(groupRide.id, {
      onPosition: handlePosition,
      onJoined: handleJoined,
      onLeft: handleLeft,
      onEnded: handleEnded,
      onError: handleError,
    });

    return () => {
      groupRideSocket.disconnect();
    };
  }, [mode, groupRide?.id]);

  // ── Publish own position while riding ──
  useEffect(() => {
    if (mode !== "active") return;
    if (!isRiding || !myLocation) return;
    groupRideSocket.publishPosition({
      lat: myLocation.lat,
      lng: myLocation.lng,
      speed: myLocation.speed,
    });
  }, [mode, isRiding, myLocation]);

  const handleCreate = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setErrorMessage(translate("Give the ride a name first."));
      return;
    }
    // Proactive gate: the idle create/join UI is hidden entirely once the
    // snapshot resolves off (see the `mode === "idle"` render branch
    // below), so this only guards a stale closure. Kept for parity with
    // the established pattern (CommuteScreen/RideDetailScreen).
    if (groupRidesResolved && !groupRidesEnabled) {
      setUpgradeVisible(true);
      return;
    }
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const detail = await api.createGroupRide(trimmed);
      setGroupRide(detail);
      setMode("active");
    } catch (err) {
      // Reactive safety net: covers a revoke between the entitlement
      // snapshot refresh and this request reaching the server.
      if (err instanceof ApiError && err.status === 403) {
        setUpgradeVisible(true);
      } else {
        setErrorMessage(
          getUserFacingErrorMessage(
            err,
            translate("Couldn't create the ride."),
          ),
        );
      }
    } finally {
      setSubmitting(false);
    }
  }, [name, groupRidesResolved, groupRidesEnabled, translate]);

  const handleJoin = useCallback(async () => {
    const trimmed = uppercaseGroupRideCode(joinCode.trim());
    if (trimmed.length !== 6) {
      setErrorMessage(
        translate("Codes are {count, number} characters.", { count: 6 }),
      );
      return;
    }
    // See the matching comment in `handleCreate` above.
    if (groupRidesResolved && !groupRidesEnabled) {
      setUpgradeVisible(true);
      return;
    }
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const detail = await api.joinGroupRide(trimmed);
      setGroupRide(detail);
      setMode("active");
    } catch (err) {
      // Reactive safety net — see `handleCreate`. Distinguish the two 403s:
      // a `max_group_ride_members` cap rejection means the owner's ride is
      // full (upgrading won't help the joiner), so it gets a plain message —
      // only a bare entitlement-gate 403 opens the group_rides upsell.
      if (isGroupMemberCapError(err)) {
        setErrorMessage(translate("This group ride is full."));
      } else if (err instanceof ApiError && err.status === 403) {
        setUpgradeVisible(true);
      } else {
        setErrorMessage(
          getUserFacingErrorMessage(err, translate("Couldn't join that ride.")),
        );
      }
    } finally {
      setSubmitting(false);
    }
  }, [joinCode, groupRidesResolved, groupRidesEnabled, translate]);

  const handleLeave = useCallback(async () => {
    if (!groupRide) return;
    const confirmed = await new Promise<boolean>((resolve) => {
      Alert.alert(
        translate("Leave group ride?"),
        translate("Other riders will stop seeing your position immediately."),
        [
          {
            text: translate("Cancel"),
            style: "cancel",
            onPress: () => resolve(false),
          },
          {
            text: translate("Leave"),
            style: "destructive",
            onPress: () => resolve(true),
          },
        ],
      );
    });
    if (!confirmed) return;
    // Disconnect BEFORE the REST call so the server's `group:left`
    // (and the auto-emitted `group:ended` if this leave ends the ride)
    // fan-out doesn't echo back to our own socket — otherwise the
    // self-initiated "owner ended the ride" alert would race with the
    // teardown below. The fail-closed contract is unchanged: even if
    // the REST call rejects, the socket stays disconnected.
    groupRideSocket.disconnect();
    try {
      await api.leaveGroupRide(groupRide.id);
    } catch {
      // The rider's intent was clear; we'd rather drop a server-side
      // row stale than keep publishing positions after they tapped
      // Leave.
    }
    setMode("idle");
    setGroupRide(null);
    setErrorMessage(null);
    positionsRef.current = {};
  }, [groupRide, translate]);

  // Owner-only "End ride for everyone" flow. The leave path also ends
  // the ride when the owner is the last one out, but an explicit End
  // button lets the owner shut down the session up-front rather than
  // having to drain the group manually first.
  const handleEnd = useCallback(async () => {
    if (!groupRide) return;
    const confirmed = await new Promise<boolean>((resolve) => {
      Alert.alert(
        translate("End group ride?"),
        translate(
          "Everyone in the ride will be disconnected and the code will stop working.",
        ),
        [
          {
            text: translate("Cancel"),
            style: "cancel",
            onPress: () => resolve(false),
          },
          {
            text: translate("End"),
            style: "destructive",
            onPress: () => resolve(true),
          },
        ],
      );
    });
    if (!confirmed) return;
    // Detach from the room before kicking off the REST call so the
    // server's `group:ended` fanout (which uses `server.to(...)` and
    // therefore includes the originator) can't trigger our own
    // `handleEnded` alert. See the matching note in `handleLeave`.
    groupRideSocket.disconnect();
    try {
      await api.endGroupRide(groupRide.id);
    } catch {
      // Same fail-closed reasoning as `handleLeave` — the owner asked
      // for the ride to be over, so the local UI tears down regardless
      // of the REST call's outcome.
    }
    setMode("idle");
    setGroupRide(null);
    setErrorMessage(null);
    positionsRef.current = {};
  }, [groupRide, translate]);

  const isOwner =
    currentUserId !== null && groupRide?.owner_id === currentUserId;

  // Stable colour assignment keyed by user_id. Without this, the map
  // (which filters out members with no broadcast position yet) and the
  // member list (which renders every member) walked different index
  // spaces, so a member who'd just joined and shifted everyone in the
  // list by one would get a different colour on the map than next to
  // their name. Sorting by `joined_at` (with user_id as tiebreaker)
  // gives both views the same lookup table.
  const colorByUserId = useMemo(() => {
    void positionTick;
    const sorted = Object.values(positionsRef.current).sort((a, b) => {
      if (a.joined_at !== b.joined_at) {
        return a.joined_at < b.joined_at ? -1 : 1;
      }
      return a.user_id < b.user_id ? -1 : 1;
    });
    // Use a plain object — `Map` is also a named import from
    // `@maplibre/maplibre-react-native` in this file, so the global
    // constructor isn't reachable here.
    const lookup: Record<string, string> = {};
    sorted.forEach((m, idx) => {
      const color = MEMBER_COLORS[idx % MEMBER_COLORS.length];
      if (color) lookup[m.user_id] = color;
    });
    return lookup;
  }, [positionTick]);

  const memberFeatures = useMemo(() => {
    void positionTick;
    const members = Object.values(positionsRef.current).filter(
      (m) => m.last_lat != null && m.last_lng != null,
    );
    return {
      type: "FeatureCollection" as const,
      features: members.map((m) => ({
        type: "Feature" as const,
        geometry: {
          type: "Point" as const,
          coordinates: [m.last_lng as number, m.last_lat as number],
        },
        properties: {
          user_id: m.user_id,
          display_name: m.display_name,
          color: colorByUserId[m.user_id] ?? MEMBER_COLORS[0],
        },
      })),
    };
  }, [positionTick, colorByUserId]);

  const initialCenter = useMemo<[number, number]>(() => {
    const first = Object.values(positionsRef.current).find(
      (m) => m.last_lat != null && m.last_lng != null,
    );
    if (first?.last_lat != null && first?.last_lng != null) {
      return [first.last_lng, first.last_lat];
    }
    if (myLocation) return [myLocation.lng, myLocation.lat];
    return [0, 0];
  }, [groupRide?.id, myLocation]);

  if (mode === "idle") {
    // Fail closed: no snapshot yet means we don't know if this rider is
    // entitled. Show the same neutral spinner as the rest of the app's
    // gates rather than flash either the paid create/join UI or the
    // upsell.
    if (!groupRidesResolved) {
      return (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={t.fg} />
        </View>
      );
    }

    // #M2: group_rides is Premium-only. Once resolved-off, replace the
    // create/join entry surface with a locked upsell instead of letting
    // the rider fill out a form that would only 403. This ONLY gates the
    // idle entry point — a rider already `active` in a group ride (e.g.
    // joined before a downgrade) keeps the live map and Leave/End
    // controls below, mirroring how the backend keeps those cleanup
    // paths reachable regardless of entitlement.
    if (!groupRidesEnabled) {
      return <GroupRideLockedScreen tier={tier ?? "free"} />;
    }

    return (
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          style={styles.container}
          contentContainerStyle={styles.idleContent}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.hero}>
            <View style={styles.heroIconWrap}>
              <Icon name="account-group" size={32} color={t.fg} />
            </View>
            <Text style={styles.title}>{translate("Group ride")}</Text>
            <Text style={styles.subtitle}>
              {translate(
                "Share your live position with friends so you can regroup if you get separated. Sharing is opt-in and you can leave at any time.",
              )}
            </Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>
              {translate("Create a new group ride")}
            </Text>
            <Text style={styles.label}>{translate("Name")}</Text>
            <TextInput
              style={styles.input}
              placeholder={translate("e.g. Sunday Dolomites")}
              placeholderTextColor={t.mute}
              value={name}
              onChangeText={setName}
              maxLength={100}
            />
            <TouchableOpacity
              style={[styles.primaryBtn, submitting && styles.btnDisabled]}
              onPress={handleCreate}
              disabled={submitting}
            >
              {submitting ? (
                <ActivityIndicator color={t.invFg} />
              ) : (
                <>
                  <Icon name="plus-circle" size={18} color={t.invFg} />
                  <Text style={styles.primaryBtnLabel}>
                    {translate("Create")}
                  </Text>
                </>
              )}
            </TouchableOpacity>
          </View>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>
              {translate("Join with a code")}
            </Text>
            <Text style={styles.label}>
              {translate("{count, number}-character code", { count: 6 })}
            </Text>
            <TextInput
              style={[styles.input, styles.codeInput]}
              placeholder={translate("ABCDEF")}
              placeholderTextColor={t.mute}
              value={joinCode}
              onChangeText={(v) => setJoinCode(uppercaseGroupRideCode(v))}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={6}
            />
            <TouchableOpacity
              style={[styles.secondaryBtn, submitting && styles.btnDisabled]}
              onPress={handleJoin}
              disabled={submitting}
            >
              {submitting ? (
                <ActivityIndicator color={t.fg} />
              ) : (
                <>
                  <Icon name="account-multiple-plus" size={18} color={t.fg} />
                  <Text style={styles.secondaryBtnLabel}>
                    {translate("Join")}
                  </Text>
                </>
              )}
            </TouchableOpacity>
          </View>

          {errorMessage ? (
            <View style={styles.errorBanner}>
              <Icon name="alert-circle" size={18} color={statusFg.danger} />
              <Text style={styles.errorText}>{errorMessage}</Text>
            </View>
          ) : null}
        </ScrollView>
        <UpgradePrompt
          visible={upgradeVisible}
          capability={{ feature: "group_rides" }}
          currentTier={tier ?? "free"}
          message={translate("Group rides are a Premium feature.")}
          onClose={() => setUpgradeVisible(false)}
        />
      </KeyboardAvoidingView>
    );
  }

  if (!groupRide) return null;

  const members = Object.values(positionsRef.current);

  return (
    <View style={styles.flex}>
      <View style={styles.activeHeader}>
        <View style={styles.activeHeaderRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.activeName} numberOfLines={1}>
              {groupRide.name}
            </Text>
            <Text style={styles.activeCode}>
              {translate("Code: {code}", { code: groupRide.code })}
            </Text>
          </View>
          {isOwner ? (
            <TouchableOpacity style={styles.leaveBtn} onPress={handleEnd}>
              <Icon
                name="stop-circle-outline"
                size={16}
                color={statusFg.danger}
              />
              <Text style={styles.leaveLabel}>{translate("End")}</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity style={styles.leaveBtn} onPress={handleLeave}>
            <Icon name="exit-to-app" size={16} color={statusFg.danger} />
            <Text style={styles.leaveLabel}>{translate("Leave")}</Text>
          </TouchableOpacity>
        </View>
        {!isRiding ? (
          <Text style={styles.activeHint}>
            {translate("Start a ride to broadcast your position to the group.")}
          </Text>
        ) : null}
      </View>

      <View style={styles.mapWrap}>
        <Map style={styles.map} mapStyle={APP_MAP_STYLE_URL} logo={false}>
          <Camera
            initialViewState={{
              center: initialCenter,
              zoom: 11,
            }}
          />
          <GeoJSONSource id="group-members" data={memberFeatures}>
            <Layer
              type="circle"
              id="group-members-dot"
              source="group-members"
              paint={{
                "circle-radius": 8,
                "circle-color": ["get", "color"],
                "circle-stroke-color": "#ffffff",
                "circle-stroke-width": 2,
              }}
            />
            <Layer
              type="symbol"
              id="group-members-label"
              source="group-members"
              layout={{
                "text-field": ["get", "display_name"],
                "text-size": 11,
                "text-offset": [0, 1.4],
              }}
              paint={{
                // Ink label with a cream halo so member names stay legible
                // over the basemap. The dot colours below are the essential
                // per-member encoding and are left as-is.
                "text-color": t.fg,
                "text-halo-color": t.bg,
                "text-halo-width": 1.5,
              }}
            />
          </GeoJSONSource>
        </Map>
      </View>

      <View style={styles.memberList}>
        <Text style={styles.memberListTitle}>
          {translate("Members ({count})", { count: members.length })}
        </Text>
        {members.map((m) => (
          <View key={m.user_id} style={styles.memberRow}>
            <View
              style={[
                styles.memberDot,
                {
                  backgroundColor: colorByUserId[m.user_id] ?? MEMBER_COLORS[0],
                },
              ]}
            />
            <Text style={styles.memberName} numberOfLines={1}>
              {m.display_name}
            </Text>
            <Text style={styles.memberMeta}>
              {m.last_speed != null
                ? formatSpeedKmh(m.last_speed)
                : translate("no signal")}
            </Text>
          </View>
        ))}
      </View>

      {errorMessage ? (
        <View style={styles.errorBanner}>
          <Icon name="alert-circle" size={18} color={statusFg.danger} />
          <Text style={styles.errorText}>{errorMessage}</Text>
        </View>
      ) : null}
    </View>
  );
}

// #M2: shown instead of the idle create/join UI when the entitlement
// snapshot is resolved and `group_rides` is off. Mirrors
// `CommuteLockedScreen` (#M1): the modal starts open so the rider sees
// the upsell immediately, and dismissing it leaves the locked message
// underneath rather than a blank screen.
function GroupRideLockedScreen({ tier }: { tier: SubscriptionTier }) {
  const translate = useTranslation();
  const [dismissed, setDismissed] = useState(false);
  // A Premium rider with group_rides force-off has no higher tier to buy →
  // neutral copy instead of an upgrade the rider can't act on.
  const hasUpgrade = upgradeTierForFeature("group_rides", tier) !== null;
  return (
    <View style={styles.centered}>
      <Icon name="lock-outline" size={48} color={t.dim} />
      <Text style={styles.emptyTitle}>
        {translate("Group rides are a Premium feature")}
      </Text>
      <Text style={styles.emptyBody}>
        {hasUpgrade
          ? translate(
              "Upgrade to create a group ride, join one with a code, and share your live position with friends.",
            )
          : translate("Group rides aren't available on your current plan.")}
      </Text>
      <UpgradePrompt
        visible={!dismissed}
        capability={{ feature: "group_rides" }}
        currentTier={tier}
        message={translate("Group rides are a Premium feature.")}
        neutralMessage={translate(
          "Group rides aren't available on your current plan.",
        )}
        onClose={() => setDismissed(true)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    backgroundColor: t.bg,
    alignItems: "center",
    justifyContent: "center",
    padding: brandSpacing.s5,
    gap: brandSpacing.s3,
  },
  emptyTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 18,
    fontWeight: "700",
    marginTop: brandSpacing.s3,
  },
  emptyBody: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    textAlign: "center",
    lineHeight: 22,
  },
  flex: { flex: 1, backgroundColor: t.bg },
  container: { flex: 1, backgroundColor: t.bg },
  idleContent: {
    padding: brandSpacing.s4,
    gap: brandSpacing.s4,
  },
  hero: {
    alignItems: "center",
    gap: brandSpacing.s2,
    paddingVertical: brandSpacing.s4,
  },
  heroIconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: t.raised2,
    borderWidth: 1,
    borderColor: t.line,
  },
  title: {
    fontFamily: brandFonts.sans,
    fontSize: 24,
    fontWeight: "800",
    letterSpacing: -0.3,
    color: t.fg,
  },
  subtitle: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    textAlign: "center",
    lineHeight: 20,
    paddingHorizontal: brandSpacing.s3,
  },
  card: {
    backgroundColor: t.raised,
    borderRadius: brandRadii.md,
    padding: brandSpacing.s4,
    gap: brandSpacing.s2,
    borderWidth: 1,
    borderColor: t.line,
  },
  sectionTitle: {
    fontFamily: brandFonts.sans,
    fontSize: 16,
    fontWeight: "700",
    color: t.fg,
  },
  label: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  input: {
    backgroundColor: t.sunken,
    borderWidth: 1,
    borderColor: t.line,
    borderRadius: brandRadii.sm,
    paddingHorizontal: brandSpacing.s3,
    paddingVertical: brandSpacing.s2,
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
  },
  codeInput: {
    fontFamily: brandFonts.mono,
    letterSpacing: 4,
    textAlign: "center",
    textTransform: "uppercase",
  },
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: brandSpacing.s2,
    minHeight: 44,
    paddingVertical: brandSpacing.s3,
    borderRadius: brandRadii.pill,
    backgroundColor: t.invBg,
  },
  primaryBtnLabel: {
    color: t.invFg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "700",
  },
  secondaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: brandSpacing.s2,
    minHeight: 44,
    paddingVertical: brandSpacing.s3,
    borderRadius: brandRadii.pill,
    backgroundColor: t.raised,
    borderWidth: 1,
    borderColor: t.lineStrong,
  },
  secondaryBtnLabel: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "700",
  },
  btnDisabled: { opacity: 0.6 },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s2,
    padding: brandSpacing.s3,
    margin: brandSpacing.s3,
    borderRadius: brandRadii.sm,
    backgroundColor: t.raised2,
    borderWidth: 1,
    borderColor: statusFg.danger,
  },
  errorText: {
    flex: 1,
    color: statusFg.danger,
    fontFamily: brandFonts.sans,
    fontSize: 13,
  },
  activeHeader: {
    padding: brandSpacing.s4,
    backgroundColor: t.raised,
    borderBottomWidth: 1,
    borderBottomColor: t.line,
    gap: brandSpacing.s1,
  },
  activeHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s3,
  },
  activeName: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 16,
    fontWeight: "700",
  },
  activeCode: {
    color: t.dim,
    fontSize: 13,
    letterSpacing: 2,
    fontFamily: brandFonts.mono,
  },
  activeHint: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
  },
  leaveBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s1,
    paddingHorizontal: brandSpacing.s3,
    minHeight: 44,
    paddingVertical: brandSpacing.s2,
    borderRadius: brandRadii.pill,
    borderWidth: 1,
    borderColor: statusFg.danger,
  },
  leaveLabel: {
    color: statusFg.danger,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    fontWeight: "600",
  },
  mapWrap: {
    flex: 1,
  },
  map: {
    flex: 1,
  },
  memberList: {
    padding: brandSpacing.s3,
    gap: brandSpacing.s1,
    backgroundColor: t.raised,
    borderTopWidth: 1,
    borderTopColor: t.line,
    maxHeight: 220,
  },
  memberListTitle: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: brandSpacing.s1,
  },
  memberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s2,
    paddingVertical: brandSpacing.s1,
  },
  memberDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  memberName: {
    flex: 1,
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "500",
  },
  memberMeta: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
  },
});
