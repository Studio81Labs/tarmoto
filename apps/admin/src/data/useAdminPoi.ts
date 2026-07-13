import { $api } from "./apiClient.js";

/**
 * Poll interval for the POI Imports page (#847). Both queries below back a
 * live coverage table — `live_state` (idle/queued/running) and fresh
 * `last_run`/`poi_count` values only update if the page keeps polling, since
 * nothing pushes a change event to the browser when a BullMQ job transitions
 * or a cron-dispatched import finishes.
 */
const POI_LIVE_REFETCH_INTERVAL_MS = 4000;

export function useAdminPoiRegions() {
  return $api.useQuery("get", "/admin/poi/regions", undefined, {
    refetchInterval: POI_LIVE_REFETCH_INTERVAL_MS,
  });
}

export function useAdminPoiRuns(params: {
  source?: string;
  code?: string;
  limit?: number;
}) {
  return $api.useQuery(
    "get",
    "/admin/poi/runs",
    { params: { query: params } },
    { refetchInterval: POI_LIVE_REFETCH_INTERVAL_MS },
  );
}

export function useTriggerPoiImport() {
  return $api.useMutation("post", "/admin/poi/regions/{source}/{code}/import");
}

export function useUploadPoiExtract() {
  return $api.useMutation("post", "/admin/poi/regions/{source}/{code}/extract");
}
