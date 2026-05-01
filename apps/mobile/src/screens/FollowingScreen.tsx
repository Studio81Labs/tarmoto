/**
 * FollowingScreen — US-27 list of riders that the given user follows.
 *
 * Mirror of `FollowersScreen` — different endpoint, same UI, picked by
 * the `mode` prop on `FollowList`.
 */
import React from "react";
import { useRoute } from "@react-navigation/native";
import type { RouteProp } from "@react-navigation/native";
import type { ProfileStackParamList } from "@/navigation/RootNavigator";
import FollowList from "./FollowList";

type Route = RouteProp<ProfileStackParamList, "Following">;

export default function FollowingScreen() {
  const { params } = useRoute<Route>();
  return (
    <FollowList
      userId={params.userId}
      displayName={params.displayName}
      mode="following"
    />
  );
}
