import { API_BASE_SERVER } from "@/lib/config";
import type { paths } from "@tarmoto/openapi/types";

export type SharedRideDetail =
  paths["/api/v1/rides/shared/{token}"]["get"]["responses"]["200"]["content"]["application/json"];

export async function fetchSharedRide(
  token: string,
): Promise<SharedRideDetail | null> {
  const res = await fetch(
    `${API_BASE_SERVER}/rides/shared/${encodeURIComponent(token)}`,
    {
      cache: "no-store",
    },
  );

  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GET /rides/shared/${token} failed (${res.status})`);
  }

  return (await res.json()) as SharedRideDetail;
}
