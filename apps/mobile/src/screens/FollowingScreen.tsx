/**
 * FollowingScreen — US-27 list of riders that the given user follows.
 *
 * Mirror of `FollowersScreen` — different endpoint, same UI.
 */
import React from "react";
import { useRoute } from "@react-navigation/native";
import type { RouteProp } from "@react-navigation/native";
import { api } from "@/services/api";
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
      fetcher={api.listFollowing.bind(api)}
    />
  );
}
