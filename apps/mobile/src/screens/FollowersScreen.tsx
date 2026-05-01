/**
 * FollowersScreen — US-27 list of who follows a given rider.
 *
 * Backed by `GET /users/:userId/followers`. Tapping a row pushes the
 * tapped rider's `ViewProfile` so the rider can drill from a list back
 * into another profile without losing their place.
 */
import React from "react";
import { useRoute } from "@react-navigation/native";
import type { RouteProp } from "@react-navigation/native";
import type { ProfileStackParamList } from "@/navigation/RootNavigator";
import FollowList from "./FollowList";

type Route = RouteProp<ProfileStackParamList, "Followers">;

export default function FollowersScreen() {
  const { params } = useRoute<Route>();
  return (
    <FollowList
      userId={params.userId}
      displayName={params.displayName}
      mode="followers"
    />
  );
}
