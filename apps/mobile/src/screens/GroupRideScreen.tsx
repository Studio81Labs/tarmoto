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
import { api } from "@/services/api";
import { groupRideSocket } from "@/services/groupRideSocket";
import { DEV_MAP_STYLE_URL } from "./MapScreen.helpers";
import { useAuthStore, useRideStore } from "@/stores";
import type {
  GroupEndedEvent,
  GroupJoinedEvent,
  GroupLeftEvent,
  GroupPositionEvent,
  GroupRideDetail,
  GroupRideMember,
} from "@/types";

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

export default function GroupRideScreen() {
  const [mode, setMode] = useState<Mode>("idle");
  const [groupRide, setGroupRide] = useState<GroupRideDetail | null>(null);
  const [name, setName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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
      Alert.alert("Group ride", `${event.display_name} joined.`);
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
      Alert.alert("Group ride ended", "The owner ended the ride.");
      teardownToIdle();
    };

    // Some failure modes from the gateway are terminal for this
    // session — the room is gone or the rider is no longer welcome —
    // and leaving the rider on a stuck "active" screen with just an
    // error banner means they have to tap Leave to recover. Detect
    // those messages and run the same teardown as `handleEnded`.
    // Anything else (transient network blip, throttle complaint) is
    // surfaced as an inline error banner without ripping the screen
    // down.
    const TERMINAL_ERROR_MESSAGES = new Set([
      "Group ride has ended",
      "Group ride not found or access denied",
    ]);

    const handleError = (msg: string): void => {
      if (TERMINAL_ERROR_MESSAGES.has(msg)) {
        Alert.alert("Group ride", msg);
        teardownToIdle();
        return;
      }
      setErrorMessage(msg);
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
      setErrorMessage("Give the ride a name first.");
      return;
    }
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const detail = await api.createGroupRide(trimmed);
      setGroupRide(detail);
      setMode("active");
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Couldn't create the ride.",
      );
    } finally {
      setSubmitting(false);
    }
  }, [name]);

  const handleJoin = useCallback(async () => {
    const trimmed = joinCode.trim().toUpperCase();
    if (trimmed.length !== 6) {
      setErrorMessage("Codes are 6 characters.");
      return;
    }
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const detail = await api.joinGroupRide(trimmed);
      setGroupRide(detail);
      setMode("active");
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Couldn't join that ride.",
      );
    } finally {
      setSubmitting(false);
    }
  }, [joinCode]);

  const handleLeave = useCallback(async () => {
    if (!groupRide) return;
    const confirmed = await new Promise<boolean>((resolve) => {
      Alert.alert(
        "Leave group ride?",
        "Other riders will stop seeing your position immediately.",
        [
          { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
          { text: "Leave", style: "destructive", onPress: () => resolve(true) },
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
  }, [groupRide]);

  // Owner-only "End ride for everyone" flow. The leave path also ends
  // the ride when the owner is the last one out, but an explicit End
  // button lets the owner shut down the session up-front rather than
  // having to drain the group manually first.
  const handleEnd = useCallback(async () => {
    if (!groupRide) return;
    const confirmed = await new Promise<boolean>((resolve) => {
      Alert.alert(
        "End group ride?",
        "Everyone in the ride will be disconnected and the code will stop working.",
        [
          { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
          { text: "End", style: "destructive", onPress: () => resolve(true) },
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
  }, [groupRide]);

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
            <Text style={styles.title}>Group ride</Text>
            <Text style={styles.subtitle}>
              Share your live position with friends so you can regroup if you
              get separated. Sharing is opt-in and you can leave at any time.
            </Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Create a new group ride</Text>
            <Text style={styles.label}>Name</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. Sunday Dolomites"
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
                  <Text style={styles.primaryBtnLabel}>Create</Text>
                </>
              )}
            </TouchableOpacity>
          </View>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Join with a code</Text>
            <Text style={styles.label}>6-character code</Text>
            <TextInput
              style={[styles.input, styles.codeInput]}
              placeholder="ABCDEF"
              placeholderTextColor={t.mute}
              value={joinCode}
              onChangeText={(v) => setJoinCode(v.toUpperCase())}
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
                  <Text style={styles.secondaryBtnLabel}>Join</Text>
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
            <Text style={styles.activeCode}>Code: {groupRide.code}</Text>
          </View>
          {isOwner ? (
            <TouchableOpacity style={styles.leaveBtn} onPress={handleEnd}>
              <Icon
                name="stop-circle-outline"
                size={16}
                color={statusFg.danger}
              />
              <Text style={styles.leaveLabel}>End</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity style={styles.leaveBtn} onPress={handleLeave}>
            <Icon name="exit-to-app" size={16} color={statusFg.danger} />
            <Text style={styles.leaveLabel}>Leave</Text>
          </TouchableOpacity>
        </View>
        {!isRiding ? (
          <Text style={styles.activeHint}>
            Start a ride to broadcast your position to the group.
          </Text>
        ) : null}
      </View>

      <View style={styles.mapWrap}>
        <Map style={styles.map} mapStyle={DEV_MAP_STYLE_URL} logo={false}>
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
              style={{
                circleRadius: 8,
                circleColor: ["get", "color"],
                circleStrokeColor: "#ffffff",
                circleStrokeWidth: 2,
              }}
            />
            <Layer
              type="symbol"
              id="group-members-label"
              source="group-members"
              style={{
                textField: ["get", "display_name"],
                textSize: 11,
                textOffset: [0, 1.4],
                // Ink label with a cream halo so member names stay legible
                // over the basemap. The dot colours below are the essential
                // per-member encoding and are left as-is.
                textColor: t.fg,
                textHaloColor: t.bg,
                textHaloWidth: 1.5,
              }}
            />
          </GeoJSONSource>
        </Map>
      </View>

      <View style={styles.memberList}>
        <Text style={styles.memberListTitle}>Members ({members.length})</Text>
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
                ? `${Math.round(m.last_speed)} km/h`
                : "no signal"}
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

const styles = StyleSheet.create({
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
