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
 *
 * `truncated` is carried through from the response so the caller can tell the
 * rider when older routes are hidden by the cap (rather than silently showing
 * an incomplete overlay).
 */
export function useUserRideTracks(options?: {
  enabled?: boolean;
  /**
   * Only rides started on/after this ISO instant (passed to the endpoint's
   * `started_from`). Lets a time-windowed view (e.g. the road map's period
   * pills) show routes for the same window as the rest of the page.
   */
  startedFrom?: string | null;
}): {
  tracks: RideTrack[];
  truncated: boolean;
  loading: boolean;
  error: boolean;
} {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const enabled = userId != null && (options?.enabled ?? true);
  const startedFrom = options?.startedFrom ?? null;

  const query = useQuery({
    queryKey: ["user-ride-tracks", userId, startedFrom],
    enabled,
    queryFn: async ({ signal }) => {
      const { data, error } = await api.GET("/api/v1/rides/tracks", {
        ...(startedFrom
          ? { params: { query: { started_from: startedFrom } } }
          : {}),
        signal,
      });
      if (error || !data) throw new Error("ride tracks fetch failed");
      const res = data as RideTracksResponse;
      return { tracks: res.tracks ?? EMPTY, truncated: res.truncated ?? false };
    },
  });

  return {
    tracks: query.data?.tracks ?? EMPTY,
    truncated: query.data?.truncated ?? false,
    loading: query.isLoading,
    error: query.isError,
  };
}
