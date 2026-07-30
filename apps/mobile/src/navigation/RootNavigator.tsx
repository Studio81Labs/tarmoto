/**
 * Tarmoto Navigation
 * Tab-based navigation with stack navigators per tab.
 */

import React from "react";
import {
  getFocusedRouteNameFromRoute,
  NavigationContainer,
  type NavigatorScreenParams,
} from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { Icon } from "@/components/Icon";
type IconName = React.ComponentProps<typeof Icon>["name"];
import { ACCENT_DARK, brandColorsLight } from "@/theme/brand";
import type { HazardType, LatLng, Waypoint } from "@/types";
import { linking } from "./linking";
import CarPlayRideMirror from "@/components/CarPlayRideMirror";
import RideDurationTicker from "@/components/RideDurationTicker";
import CrashDetectionRunner from "@/components/CrashDetectionRunner";
import RideTrackingKillWatcher from "@/components/RideTrackingKillWatcher";
import CrashAlertOverlay from "@/components/CrashAlertOverlay";

// Screens
import HomeScreen from "@/screens/HomeScreen";
import MapScreen from "@/screens/MapScreen";
import RideScreen from "@/screens/RideScreen";
import TripsScreen from "@/screens/TripsScreen";
import ProfileScreen from "@/screens/ProfileScreen";

// Stack screens
import RideActiveScreen from "@/screens/RideActiveScreen";
import HazardReportScreen from "@/screens/HazardReportScreen";
import RoadPreviewScreen from "@/screens/RoadPreviewScreen";
import TripDetailScreen from "@/screens/TripDetailScreen";
import TripDayScreen from "@/screens/TripDayScreen";
import TripCreateScreen from "@/screens/TripCreateScreen";
import NavigationScreen from "@/screens/NavigationScreen";
import CommuteScreen from "@/screens/CommuteScreen";
import RideDetailScreen from "@/screens/RideDetailScreen";
import SettingsScreen from "@/screens/SettingsScreen";
import JoinTripScreen from "@/screens/JoinTripScreen";
import LinkAccountScreen from "@/screens/LinkAccountScreen";
import OfflineRegionsScreen from "@/screens/OfflineRegionsScreen";
import EmergencyContactsScreen from "@/screens/EmergencyContactsScreen";
import GroupRideScreen from "@/screens/GroupRideScreen";
import EditProfileModal from "@/screens/EditProfileModal";
import ViewProfileScreen from "@/screens/ViewProfileScreen";
import FollowersScreen from "@/screens/FollowersScreen";
import FollowingScreen from "@/screens/FollowingScreen";
import AchievementsScreen from "@/screens/AchievementsScreen";
import BadgesScreen from "@/screens/BadgesScreen";
import ChallengesScreen from "@/screens/ChallengesScreen";
import PersonalRoadMapScreen from "@/screens/PersonalRoadMapScreen";
import { useTranslation } from "@/i18n/I18nProvider";

// ── Type definitions ──

// `NavigatorScreenParams` lets cross-tab navigation describe the nested
// screen + params type-safely. Used by US-21 / US-22 where the
// "Start commute" CTA on Home jumps the rider into RideTab → RideActive.
export type RootTabParamList = {
  HomeTab: NavigatorScreenParams<HomeStackParamList> | undefined;
  MapTab: NavigatorScreenParams<MapStackParamList> | undefined;
  RideTab: NavigatorScreenParams<RideStackParamList> | undefined;
  TripsTab: NavigatorScreenParams<TripsStackParamList> | undefined;
  ProfileTab: NavigatorScreenParams<ProfileStackParamList> | undefined;
};

/**
 * `NavigationScreen` accepts two shapes:
 *   - `trip-day`: resolves polyline + waypoints from the active trip in
 *     `useTripStore`. Used by the trips flow where the rider taps Start
 *     Navigation on a planned day.
 *   - `polyline`: caller passes the route geometry directly. Used by
 *     commute (and any future ad-hoc routing surface) so the screen
 *     doesn't need a fake trip-day shim.
 *
 * Both stacks that register `Navigate` (Trips for the legacy flow, Home
 * for commute) share this exact param type.
 */
export type NavigateParams =
  | { source: "trip-day"; tripId: string; dayNumber: number }
  | {
      source: "polyline";
      polyline: LatLng[];
      title?: string;
      waypoints?: Waypoint[];
    };

export type HomeStackParamList = {
  Home: undefined;
  Commute: undefined;
  Navigate: NavigateParams;
  RideDetail: { rideId: string };
};

export type MapStackParamList = {
  Map: undefined;
  RoadPreview: { segmentId: string };
  // Mirrors the RideStack registration so the FAB on MapScreen stays
  // inside its own tab; opening the modal cross-tab would land the
  // rider on the Ride tab once they dismiss, which is a footgun.
  HazardReport: { preselectedType?: HazardType } | undefined;
};

export type RideStackParamList = {
  RideStart: undefined;
  RideActive: { rideType: "free" | "commute" | "trip" };
  RideDetail: { rideId: string };
  HazardReport: { preselectedType?: HazardType } | undefined;
  GroupRide: undefined;
};

export type TripsStackParamList = {
  TripsList: undefined;
  TripCreate: undefined;
  TripJoin: { tripId?: string; inviteCode?: string } | undefined;
  TripDetail: { tripId: string };
  TripDay: { tripId: string; dayNumber: number };
  Navigate: NavigateParams;
  RoadPreview: { segmentId: string };
};

export type ProfileStackParamList = {
  Profile: undefined;
  Settings: undefined;
  // US-27: edit own profile (display name, bio, home region) and view another
  // rider's public profile from anywhere in the app. `Followers` / `Following`
  // sub-screens are reusable for any userId so they live in this stack rather
  // than under Profile.
  EditProfile: undefined;
  ViewProfile: { userId: string };
  Followers: { userId: string; displayName: string };
  Following: { userId: string; displayName: string };
  LinkAccount: { email?: string } | undefined;
  OfflineRegions: undefined;
  EmergencyContacts: undefined;
  Achievements: undefined;
  Badges: undefined;
  Challenges: undefined;
  PersonalRoadMap: undefined;
};

// ── Navigators ──

const Tab = createBottomTabNavigator<RootTabParamList>();
const HomeStack = createNativeStackNavigator<HomeStackParamList>();
const MapStack = createNativeStackNavigator<MapStackParamList>();
const RideStack = createNativeStackNavigator<RideStackParamList>();
const TripsStack = createNativeStackNavigator<TripsStackParamList>();
const ProfileStack = createNativeStackNavigator<ProfileStackParamList>();

// Cream + ink header — the shared chrome for every stack now that the whole
// app has moved onto the brand system. Individual screens spread this to add
// a title; the per-screen overrides remain so each can tweak its own header.
const brandScreenOptions = {
  headerStyle: { backgroundColor: brandColorsLight.bg },
  headerTintColor: brandColorsLight.fg,
  headerTitleStyle: { fontWeight: "800" as const },
  contentStyle: { backgroundColor: brandColorsLight.bg },
};

// Brand bottom tab bar: white chrome on cream, with `ACCENT_DARK` as the
// active tint. The raw accent (#FF6A1A) is only ~2.9:1 on white — below the
// 3:1 non-text floor — so the deepened burnt-orange is used; it clears
// ~5.2:1 for the small label + icon while keeping the accent identity.
const brandTabBarStyle = {
  backgroundColor: brandColorsLight.raised,
  borderTopColor: brandColorsLight.line,
  borderTopWidth: 1,
  paddingBottom: 4,
  height: 60,
};

// Immersive, full-screen child routes that should NOT show the tab bar at
// all: the live-ride HUD and turn-by-turn nav are edge-to-edge dark surfaces,
// so the (light) tab bar must not stay pinned to them. Hiding it here is both
// the correct UX and avoids attaching brand chrome to an unmigrated dark
// screen. Keyed by nested route name (resolved per active tab).
const TAB_BAR_HIDDEN_ROUTES = new Set(["RideActive", "Navigate"]);

function tabBarStyleForRoute(route: {
  name: string;
  params?: object | undefined;
}): typeof brandTabBarStyle | { display: "none" } {
  const focused = getFocusedRouteNameFromRoute(route) ?? route.name;
  return TAB_BAR_HIDDEN_ROUTES.has(focused)
    ? { display: "none" }
    : brandTabBarStyle;
}

function HomeNavigator() {
  const translate = useTranslation();
  return (
    <HomeStack.Navigator screenOptions={brandScreenOptions}>
      <HomeStack.Screen
        name="Home"
        component={HomeScreen}
        options={{ headerShown: false }}
      />
      <HomeStack.Screen
        name="Commute"
        component={CommuteScreen}
        options={brandScreenOptions}
      />
      {/*
        US-15 / #342 follow-up: commute callers (CommuteScreen alternative
        cards today, primary-route geometry once the backend caches it)
        push `Navigate` with a polyline directly. Registering the screen
        on this stack keeps the rider on the Home tab when they end the
        nav session — same footgun-avoidance pattern used for the Map
        tab's HazardReport mirror.
      */}
      <HomeStack.Screen
        name="Navigate"
        component={NavigationScreen}
        options={{ headerShown: false, presentation: "fullScreenModal" }}
      />
      <HomeStack.Screen
        name="RideDetail"
        component={RideDetailScreen}
        options={{ ...brandScreenOptions, title: translate("Ride Details") }}
      />
    </HomeStack.Navigator>
  );
}

function MapNavigator() {
  const translate = useTranslation();
  return (
    <MapStack.Navigator screenOptions={brandScreenOptions}>
      <MapStack.Screen
        name="Map"
        component={MapScreen}
        options={{ headerShown: false }}
      />
      <MapStack.Screen
        name="RoadPreview"
        component={RoadPreviewScreen}
        options={{ ...brandScreenOptions, title: translate("Road Preview") }}
      />
      <MapStack.Screen
        name="HazardReport"
        component={HazardReportScreen}
        options={{
          ...brandScreenOptions,
          title: translate("Report Hazard"),
          presentation: "modal",
        }}
      />
    </MapStack.Navigator>
  );
}

function RideNavigator() {
  const translate = useTranslation();
  return (
    <RideStack.Navigator screenOptions={brandScreenOptions}>
      <RideStack.Screen
        name="RideStart"
        component={RideScreen}
        options={{ headerShown: false }}
      />
      <RideStack.Screen
        name="RideActive"
        component={RideActiveScreen}
        options={{ headerShown: false }}
      />
      <RideStack.Screen
        name="RideDetail"
        component={RideDetailScreen}
        options={{ ...brandScreenOptions, title: translate("Ride Details") }}
      />
      <RideStack.Screen
        name="HazardReport"
        component={HazardReportScreen}
        options={{
          ...brandScreenOptions,
          title: translate("Report Hazard"),
          presentation: "modal",
        }}
      />
      <RideStack.Screen
        name="GroupRide"
        component={GroupRideScreen}
        options={{ ...brandScreenOptions, title: translate("Group Ride") }}
      />
    </RideStack.Navigator>
  );
}

function TripsNavigator() {
  const translate = useTranslation();
  return (
    <TripsStack.Navigator screenOptions={brandScreenOptions}>
      <TripsStack.Screen
        name="TripsList"
        component={TripsScreen}
        options={{ ...brandScreenOptions, title: translate("Trips") }}
      />
      <TripsStack.Screen
        name="TripCreate"
        component={TripCreateScreen}
        options={{ ...brandScreenOptions, title: translate("Plan a Trip") }}
      />
      <TripsStack.Screen
        name="TripJoin"
        component={JoinTripScreen}
        options={{ ...brandScreenOptions, title: translate("Join a Trip") }}
      />
      <TripsStack.Screen
        name="TripDetail"
        component={TripDetailScreen}
        options={{ ...brandScreenOptions, title: translate("Trip") }}
      />
      <TripsStack.Screen
        name="TripDay"
        component={TripDayScreen}
        options={{ ...brandScreenOptions, title: translate("Day Route") }}
      />
      <TripsStack.Screen
        name="Navigate"
        component={NavigationScreen}
        options={{ headerShown: false, presentation: "fullScreenModal" }}
      />
      <TripsStack.Screen
        name="RoadPreview"
        component={RoadPreviewScreen}
        options={{ ...brandScreenOptions, title: translate("Road Preview") }}
      />
    </TripsStack.Navigator>
  );
}

function ProfileNavigator() {
  const translate = useTranslation();
  return (
    <ProfileStack.Navigator screenOptions={brandScreenOptions}>
      <ProfileStack.Screen
        name="Profile"
        component={ProfileScreen}
        options={{ headerShown: false }}
      />
      <ProfileStack.Screen
        name="Settings"
        component={SettingsScreen}
        options={brandScreenOptions}
      />
      <ProfileStack.Screen
        name="EditProfile"
        component={EditProfileModal}
        options={{
          ...brandScreenOptions,
          title: translate("Edit profile"),
          presentation: "modal",
        }}
      />
      <ProfileStack.Screen
        name="ViewProfile"
        component={ViewProfileScreen}
        options={{ ...brandScreenOptions, title: translate("Rider") }}
      />
      <ProfileStack.Screen
        name="Followers"
        component={FollowersScreen}
        options={{ ...brandScreenOptions, title: translate("Followers") }}
      />
      <ProfileStack.Screen
        name="Following"
        component={FollowingScreen}
        options={{ ...brandScreenOptions, title: translate("Following") }}
      />
      <ProfileStack.Screen
        name="LinkAccount"
        component={LinkAccountScreen}
        options={{ ...brandScreenOptions, title: translate("Link account") }}
      />
      <ProfileStack.Screen
        name="OfflineRegions"
        component={OfflineRegionsScreen}
        options={{ ...brandScreenOptions, title: translate("Offline maps") }}
      />
      <ProfileStack.Screen
        name="EmergencyContacts"
        component={EmergencyContactsScreen}
        options={{
          ...brandScreenOptions,
          title: translate("Emergency contacts"),
        }}
      />
      <ProfileStack.Screen
        name="Achievements"
        component={AchievementsScreen}
        options={{ ...brandScreenOptions, title: translate("Achievements") }}
      />
      <ProfileStack.Screen
        name="Badges"
        component={BadgesScreen}
        options={{ ...brandScreenOptions, title: translate("Badges") }}
      />
      <ProfileStack.Screen
        name="Challenges"
        component={ChallengesScreen}
        options={{ ...brandScreenOptions, title: translate("Challenges") }}
      />
      <ProfileStack.Screen
        name="PersonalRoadMap"
        component={PersonalRoadMapScreen}
        options={{
          ...brandScreenOptions,
          title: translate("Personal road map"),
        }}
      />
    </ProfileStack.Navigator>
  );
}

// ── Tab icons ──

const tabIcons: Record<string, IconName> = {
  HomeTab: "home",
  MapTab: "map",
  RideTab: "play-circle",
  TripsTab: "calendar-range",
  ProfileTab: "account",
};

// ── Root Navigator ──

export default function RootNavigator() {
  const translate = useTranslation();
  return (
    <>
      {/*
        US-17 AC #3: mirror the active ride to the CarPlay information
        template from the root so the bike display follows the rider
        regardless of which tab is focused. Rendered as a sibling leaf
        (returns null) so its high-frequency ride-store subscriptions
        don't re-render the whole navigator on every tick.
      */}
      <CarPlayRideMirror />
      {/*
        US-19: the ride-duration ticker is mounted at the root so the
        elapsed count keeps advancing even when the live HUD isn't
        focused (rider on the history list, on the map, etc). Same
        leaf-component pattern as `CarPlayRideMirror` so its writes
        don't re-render the navigator tree.
      */}
      <RideDurationTicker />
      {/*
        US-12: the crash detector subscribes to the raw 50 Hz sensor
        stream while a ride is active and the rider has crash detection
        enabled. Mounted at the root so it survives tab switches mid-
        ride. Same leaf-component pattern — returns null and only
        manages side effects.
      */}
      <CrashDetectionRunner />
      {/*
        SP4: the `ride_tracking` operator kill switch. Root-mounted so it stops
        an active recording (telemetry-first) even when the rider has backed out
        of the live HUD — the GPS/sensor singletons keep running for the resume
        flow, so a screen-scoped watcher would miss a mid-ride kill.
      */}
      <RideTrackingKillWatcher />
      <NavigationContainer linking={linking}>
        <Tab.Navigator
          screenOptions={({ route }) => ({
            headerShown: false,
            // Hide the bar entirely on immersive full-screen child routes
            // (live HUD, turn-by-turn nav); brand white bar everywhere else.
            // Inactive uses the AA-safe `dim`.
            tabBarStyle: tabBarStyleForRoute(route),
            tabBarActiveTintColor: ACCENT_DARK,
            tabBarInactiveTintColor: brandColorsLight.dim,
            tabBarLabelStyle: { fontSize: 10, fontWeight: "600" },
            tabBarIcon: ({ color, size }) => (
              <Icon
                name={tabIcons[route.name] || "circle"}
                size={size}
                color={color}
              />
            ),
          })}
        >
          <Tab.Screen
            name="HomeTab"
            component={HomeNavigator}
            options={{ tabBarLabel: translate("Home") }}
          />
          <Tab.Screen
            name="MapTab"
            component={MapNavigator}
            options={{ tabBarLabel: translate("Map") }}
          />
          <Tab.Screen
            name="RideTab"
            component={RideNavigator}
            options={{ tabBarLabel: translate("Ride") }}
          />
          <Tab.Screen
            name="TripsTab"
            component={TripsNavigator}
            options={{ tabBarLabel: translate("Trips") }}
          />
          <Tab.Screen
            name="ProfileTab"
            component={ProfileNavigator}
            options={{ tabBarLabel: translate("Profile") }}
          />
        </Tab.Navigator>
      </NavigationContainer>
      {/*
        US-12: the full-screen crash alert overlay sits OUTSIDE the
        NavigationContainer so it can take over the UI from any tab —
        Modal renders at the application root regardless of where it's
        declared, but keeping it here makes the takeover surface
        explicit. Visibility is driven entirely by `useCrashStore.phase`.
      */}
      <CrashAlertOverlay />
    </>
  );
}
