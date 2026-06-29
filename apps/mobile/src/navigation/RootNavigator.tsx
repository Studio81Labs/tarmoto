/**
 * Tarmoto Navigation
 * Tab-based navigation with stack navigators per tab.
 */

import React from "react";
import {
  getFocusedRouteNameFromRoute,
  NavigationContainer,
  type LinkingOptions,
  type NavigatorScreenParams,
} from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import Icon from "@react-native-vector-icons/material-design-icons";
type IconName = React.ComponentProps<typeof Icon>["name"];
import { colors } from "@/theme";
import { ACCENT_DARK, brandColorsLight } from "@/theme/brand";
import type { HazardType, LatLng, Waypoint } from "@/types";
import { parseHazardTypeParam } from "@/services/hazardReportLink";
import CarPlayRideMirror from "@/components/CarPlayRideMirror";
import RideDurationTicker from "@/components/RideDurationTicker";
import CrashDetectionRunner from "@/components/CrashDetectionRunner";
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
import TripImportScreen from "@/screens/TripImportScreen";
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
  // US-39 / #283: deep-link target for the web "Push to mobile" handoff.
  // `tripId` matches the source planner trip and is shown to the rider
  // as a sanity check; `token` is the share token used to fetch the
  // snapshot via `/trip-shares/:token`.
  TripImport: { tripId?: string; token?: string } | undefined;
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

const linking: LinkingOptions<RootTabParamList> = {
  prefixes: ["tarmoto://"],
  config: {
    screens: {
      ProfileTab: {
        screens: {
          LinkAccount: "link-account",
        },
      },
      TripsTab: {
        screens: {
          TripJoin: "trips/join",
          // US-39 / #283: tarmoto://trips/import?tripId=...&token=...
          // is what the web "Push to mobile" action launches; we map it
          // to a dedicated screen that previews the share and posts to
          // /trips/import on confirmation.
          TripImport: "trips/import",
        },
      },
      // US-17 AC #4 — Quick-launch Commute reachable from the head unit
      // list template. `CarPlayRideMirror` fires `tarmoto://commute/start`
      // when the rider taps Start Commute on the bike display; we route
      // the URL into the existing Commute screen on the Home tab so the
      // post-launch nav state is the same as if the rider tapped Commute
      // on Home. CommuteScreen handles the "no primary route saved" case
      // with its own setup CTA, so the row is always reachable without
      // us gating it from the head unit.
      HomeTab: {
        screens: {
          Commute: "commute/start",
        },
      },
      // US-17 follow-up (#343): the Google Assistant App Action declared in
      // `android/app/src/main/res/xml/shortcuts.xml` fires this URL when the
      // rider says "Hey Google, ask Tarmoto to report a pothole" on Android
      // Auto or the phone Assistant. Routing through the Map tab means the
      // tab nav state is sane after the rider dismisses the modal — same
      // footgun-avoidance choice as the in-app FAB on MapScreen.
      MapTab: {
        screens: {
          HazardReport: {
            path: "hazard/report",
            parse: {
              preselectedType: (value: string) => parseHazardTypeParam(value),
            },
          },
        },
      },
    },
  },
};

const screenOptions = {
  headerStyle: { backgroundColor: colors.bgCard },
  headerTintColor: colors.textPrimary,
  headerTitleStyle: { fontWeight: "700" as const },
  contentStyle: { backgroundColor: colors.bg },
};

// Cream + ink header for screens migrated onto the brand system, so a
// brand screen isn't a light body under the legacy dark header. Applied
// per-screen during the incremental migration (see
// docs/design/mobile-spec/README.md); the shared chrome flips once enough
// screens have moved across.
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
  params?: object;
}): typeof brandTabBarStyle | { display: "none" } {
  const focused = getFocusedRouteNameFromRoute(route) ?? route.name;
  return TAB_BAR_HIDDEN_ROUTES.has(focused)
    ? { display: "none" }
    : brandTabBarStyle;
}

function HomeNavigator() {
  return (
    <HomeStack.Navigator screenOptions={screenOptions}>
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
        options={{ ...brandScreenOptions, title: "Ride Details" }}
      />
    </HomeStack.Navigator>
  );
}

function MapNavigator() {
  return (
    <MapStack.Navigator screenOptions={screenOptions}>
      <MapStack.Screen
        name="Map"
        component={MapScreen}
        options={{ headerShown: false }}
      />
      <MapStack.Screen
        name="RoadPreview"
        component={RoadPreviewScreen}
        options={{ ...brandScreenOptions, title: "Road Preview" }}
      />
      <MapStack.Screen
        name="HazardReport"
        component={HazardReportScreen}
        options={{
          ...brandScreenOptions,
          title: "Report Hazard",
          presentation: "modal",
        }}
      />
    </MapStack.Navigator>
  );
}

function RideNavigator() {
  return (
    <RideStack.Navigator screenOptions={screenOptions}>
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
        options={{ ...brandScreenOptions, title: "Ride Details" }}
      />
      <RideStack.Screen
        name="HazardReport"
        component={HazardReportScreen}
        options={{
          ...brandScreenOptions,
          title: "Report Hazard",
          presentation: "modal",
        }}
      />
      <RideStack.Screen
        name="GroupRide"
        component={GroupRideScreen}
        options={{ title: "Group Ride" }}
      />
    </RideStack.Navigator>
  );
}

function TripsNavigator() {
  return (
    <TripsStack.Navigator screenOptions={screenOptions}>
      <TripsStack.Screen
        name="TripsList"
        component={TripsScreen}
        options={{ ...brandScreenOptions, title: "Trips" }}
      />
      <TripsStack.Screen
        name="TripCreate"
        component={TripCreateScreen}
        options={{ ...brandScreenOptions, title: "Plan a Trip" }}
      />
      <TripsStack.Screen
        name="TripJoin"
        component={JoinTripScreen}
        options={{ title: "Join a Trip" }}
      />
      <TripsStack.Screen
        name="TripImport"
        component={TripImportScreen}
        options={{ title: "Import shared trip" }}
      />
      <TripsStack.Screen
        name="TripDetail"
        component={TripDetailScreen}
        options={{ ...brandScreenOptions, title: "Trip" }}
      />
      <TripsStack.Screen
        name="TripDay"
        component={TripDayScreen}
        options={{ ...brandScreenOptions, title: "Day Route" }}
      />
      <TripsStack.Screen
        name="Navigate"
        component={NavigationScreen}
        options={{ headerShown: false, presentation: "fullScreenModal" }}
      />
      <TripsStack.Screen
        name="RoadPreview"
        component={RoadPreviewScreen}
        options={{ ...brandScreenOptions, title: "Road Preview" }}
      />
    </TripsStack.Navigator>
  );
}

function ProfileNavigator() {
  return (
    <ProfileStack.Navigator screenOptions={screenOptions}>
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
        options={{ title: "Edit profile", presentation: "modal" }}
      />
      <ProfileStack.Screen
        name="ViewProfile"
        component={ViewProfileScreen}
        options={{ ...brandScreenOptions, title: "Rider" }}
      />
      <ProfileStack.Screen
        name="Followers"
        component={FollowersScreen}
        options={{ ...brandScreenOptions, title: "Followers" }}
      />
      <ProfileStack.Screen
        name="Following"
        component={FollowingScreen}
        options={{ ...brandScreenOptions, title: "Following" }}
      />
      <ProfileStack.Screen
        name="LinkAccount"
        component={LinkAccountScreen}
        options={{ title: "Link account" }}
      />
      <ProfileStack.Screen
        name="OfflineRegions"
        component={OfflineRegionsScreen}
        options={{ ...brandScreenOptions, title: "Offline maps" }}
      />
      <ProfileStack.Screen
        name="EmergencyContacts"
        component={EmergencyContactsScreen}
        options={{ ...brandScreenOptions, title: "Emergency contacts" }}
      />
      <ProfileStack.Screen
        name="Achievements"
        component={AchievementsScreen}
        options={{ title: "Achievements" }}
      />
      <ProfileStack.Screen
        name="Badges"
        component={BadgesScreen}
        options={{ title: "Badges" }}
      />
      <ProfileStack.Screen
        name="Challenges"
        component={ChallengesScreen}
        options={{ title: "Challenges" }}
      />
      <ProfileStack.Screen
        name="PersonalRoadMap"
        component={PersonalRoadMapScreen}
        options={{ ...brandScreenOptions, title: "Personal road map" }}
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
            options={{ tabBarLabel: "Home" }}
          />
          <Tab.Screen
            name="MapTab"
            component={MapNavigator}
            options={{ tabBarLabel: "Map" }}
          />
          <Tab.Screen
            name="RideTab"
            component={RideNavigator}
            options={{ tabBarLabel: "Ride" }}
          />
          <Tab.Screen
            name="TripsTab"
            component={TripsNavigator}
            options={{ tabBarLabel: "Trips" }}
          />
          <Tab.Screen
            name="ProfileTab"
            component={ProfileNavigator}
            options={{ tabBarLabel: "Profile" }}
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
