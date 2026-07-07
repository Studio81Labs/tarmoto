import type { paths } from "@tarmoto/openapi-client";
import { api } from "@/lib/api";
import { apiServer } from "@/lib/api/server";

export type SharedRideDetail =
  paths["/api/v1/rides/shared/{token}"]["get"]["responses"]["200"]["content"]["application/json"];

export type UserSharedRidesResponse =
  paths["/api/v1/users/{userId}/shared-rides"]["get"]["responses"]["200"]["content"]["application/json"];

export type UserSharedRide = UserSharedRidesResponse["items"][number];

export async function fetchSharedRide(
  token: string,
): Promise<SharedRideDetail | null> {
  const { data, response } = await apiServer.GET(
    "/api/v1/rides/shared/{token}",
    { params: { path: { token } }, cache: "no-store" },
  );

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`GET /rides/shared/${token} failed (${response.status})`);
  }

  return data ?? null;
}

/**
 * #371: companion sibling of mobile's `api.listUserSharedRides`. Loads the
 * paginated shared-ride feed for the rider profile page through the typed
 * client so the bearer token rides along — `is_public` filtering on the
 * backend depends on whether the viewer is the rider themselves.
 *
 * 404 collapses to `null` so the caller can render the empty state instead
 * of an error block. The backend conflates "soft-deleted user", "private
 * profile and you're not me" and "no such id" behind a 404, mirroring the
 * `RiderProfileNotFoundError` semantic on the profile fetch — the section
 * has no way to disambiguate them and the right UX is the same in all
 * three cases.
 */
export async function fetchSharedRides(
  userId: string,
  options: { limit?: number; offset?: number; signal?: AbortSignal } = {},
): Promise<UserSharedRidesResponse | null> {
  const { signal, ...query } = options;
  const result = await api.GET("/api/v1/users/{userId}/shared-rides", {
    params: { path: { userId }, query },
    ...(signal !== undefined ? { signal } : {}),
  });
  if (result.error) {
    const status = result.response?.status ?? 0;
    if (status === 404) return null;
    throw new Error(`Failed to load shared rides (${status})`);
  }
  return (result.data ?? null) as UserSharedRidesResponse | null;
}
