import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import type { components } from "@tarmoto/openapi-client";
import type { RideTrack } from "@/components/map/RideRouteLayer";

type RideTracksResponse = components["schemas"]["RideTracksResponseDto"];

const EMPTY: RideTrack[] = [];

/**
 * Fetch the signed-in rider's ride route geometry for the "My rides" overlay
 * (`GET /api/v1/rides/tracks`). The endpoint caps the result count server-side
 * (`TARMOTO_RIDE_OVERLAY_LIMIT`, ≤500), so the client sends no limit. Geometry
 * only — the drawer fetches full ride detail on click. Auth-gated + `enabled`
 * so the explorer only pulls it while the overlay is on.
 */
export function useUserRideTracks(options?: { enabled?: boolean }): {
  tracks: RideTrack[];
  loading: boolean;
  error: boolean;
} {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const enabled = userId != null && (options?.enabled ?? true);

  const query = useQuery({
    queryKey: ["user-ride-tracks", userId],
    enabled,
    queryFn: async ({ signal }) => {
      const { data, error } = await api.GET("/api/v1/rides/tracks", {
        signal,
      });
      if (error || !data) throw new Error("ride tracks fetch failed");
      return (data as RideTracksResponse).tracks ?? [];
    },
  });

  return {
    tracks: query.data ?? EMPTY,
    loading: query.isLoading,
    error: query.isError,
  };
}
