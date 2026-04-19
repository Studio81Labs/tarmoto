/**
 * Tarmoto Navigation
 * Tab-based navigation with stack navigators per tab.
 */

import React from "react";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import Icon from "@react-native-vector-icons/material-design-icons";
import { colors } from "@/theme";
import { useCarPlayRideMirror } from "@/hooks";

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
import CommuteScreen from "@/screens/CommuteScreen";
import RideDetailScreen from "@/screens/RideDetailScreen";
import SettingsScreen from "@/screens/SettingsScreen";
import JoinTripScreen from "@/screens/JoinTripScreen";
import OfflineRegionsScreen from "@/screens/OfflineRegionsScreen";

// ── Type definitions ──

export type RootTabParamList = {
  HomeTab: undefined;
  MapTab: undefined;
  RideTab: undefined;
  TripsTab: undefined;
  ProfileTab: undefined;
};

export type HomeStackParamList = {
  Home: undefined;
  Commute: undefined;
  RideDetail: { rideId: string };
};

export type MapStackParamList = {
  Map: undefined;
  RoadPreview: { segmentId: string };
};

export type RideStackParamList = {
  RideStart: undefined;
  RideActive: { rideType: "free" | "commute" | "trip" };
  HazardReport: undefined;
};

export type TripsStackParamList = {
  TripsList: undefined;
  TripCreate: undefined;
  TripJoin: { tripId?: string; inviteCode?: string } | undefined;
  TripDetail: { tripId: string };
  TripDay: { tripId: string; dayNumber: number };
  RoadPreview: { segmentId: string };
};

export type ProfileStackParamList = {
  Profile: undefined;
  Settings: undefined;
  OfflineRegions: undefined;
};

// ── Navigators ──

const Tab = createBottomTabNavigator<RootTabParamList>();
const HomeStack = createNativeStackNavigator<HomeStackParamList>();
const MapStack = createNativeStackNavigator<MapStackParamList>();
const RideStack = createNativeStackNavigator<RideStackParamList>();
const TripsStack = createNativeStackNavigator<TripsStackParamList>();
const ProfileStack = createNativeStackNavigator<ProfileStackParamList>();

const screenOptions = {
  headerStyle: { backgroundColor: colors.bgCard },
  headerTintColor: colors.textPrimary,
  headerTitleStyle: { fontWeight: "700" as const },
  contentStyle: { backgroundColor: colors.bg },
};

function HomeNavigator() {
  return (
    <HomeStack.Navigator screenOptions={screenOptions}>
      <HomeStack.Screen
        name="Home"
        component={HomeScreen}
        options={{ headerShown: false }}
      />
      <HomeStack.Screen name="Commute" component={CommuteScreen} />
      <HomeStack.Screen
        name="RideDetail"
        component={RideDetailScreen}
        options={{ title: "Ride Details" }}
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
        options={{ title: "Road Preview" }}
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
        name="HazardReport"
        component={HazardReportScreen}
        options={{ title: "Report Hazard", presentation: "modal" }}
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
        options={{ title: "Trips" }}
      />
      <TripsStack.Screen
        name="TripCreate"
        component={TripCreateScreen}
        options={{ title: "Plan a Trip" }}
      />
      <TripsStack.Screen
        name="TripJoin"
        component={JoinTripScreen}
        options={{ title: "Join a Trip" }}
      />
      <TripsStack.Screen
        name="TripDetail"
        component={TripDetailScreen}
        options={{ title: "Trip" }}
      />
      <TripsStack.Screen
        name="TripDay"
        component={TripDayScreen}
        options={{ title: "Day Route" }}
      />
      <TripsStack.Screen
        name="RoadPreview"
        component={RoadPreviewScreen}
        options={{ title: "Road Preview" }}
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
      <ProfileStack.Screen name="Settings" component={SettingsScreen} />
      <ProfileStack.Screen
        name="OfflineRegions"
        component={OfflineRegionsScreen}
        options={{ title: "Offline maps" }}
      />
    </ProfileStack.Navigator>
  );
}

// ── Tab icons ──

const tabIcons: Record<string, string> = {
  HomeTab: "home",
  MapTab: "map",
  RideTab: "play-circle",
  TripsTab: "calendar-range",
  ProfileTab: "account",
};

// ── Root Navigator ──

export default function RootNavigator() {
  // US-17 AC #3: mirror the active ride to the CarPlay information template
  // from the root so the bike display follows the rider regardless of which
  // tab is focused. No-op on Android / Jest / when CarPlay isn't connected.
  useCarPlayRideMirror();

  return (
    <NavigationContainer>
      <Tab.Navigator
        screenOptions={({ route }) => ({
          headerShown: false,
          tabBarStyle: {
            backgroundColor: colors.bgCard,
            borderTopColor: colors.border,
            borderTopWidth: 1,
            paddingBottom: 4,
            height: 60,
          },
          tabBarActiveTintColor: colors.primary,
          tabBarInactiveTintColor: colors.textTertiary,
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
  );
}
