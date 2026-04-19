/**
 * Shared ride-list fetch used by dashboards that compute stats across every
 * ride a user has (US-49 stats, US-50 road map). The backend caps `limit` at
 * 100 so we page through `offset` until we've drained `total`. `MAX_PAGES` is a
 * guard against a misbehaving server that never shrinks the batch or total —
 * we fail loudly if we hit it so callers don't silently report partial stats.
 */

import { api } from "./api";
import type { RideForStats } from "./ride-stats";

const PAGE_SIZE = 100;
const MAX_PAGES = 100;

export async function fetchAllRides(): Promise<RideForStats[]> {
  const collected: RideForStats[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data, error } = await api.GET("/api/v1/rides", {
      params: { query: { limit: PAGE_SIZE, offset: page * PAGE_SIZE } },
    });
    if (error) throw new Error("Could not load ride history");
    const batch = (data?.rides ?? []) as RideForStats[];
    collected.push(...batch);
    const total = data?.total ?? collected.length;
    if (collected.length >= total || batch.length < PAGE_SIZE) {
      return collected;
    }
  }
  throw new Error("Ride history exceeds the current pagination cap");
}
