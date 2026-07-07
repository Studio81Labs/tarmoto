import { api } from "@/lib/api";

export type RideExportFormat = "csv" | "gpx";

/** Trigger a browser download for an already-fetched export blob. */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function downloadRideExport(
  rideId: string,
  format: RideExportFormat,
): Promise<void> {
  const { data, response } =
    format === "csv"
      ? await api.GET("/api/v1/rides/{rideId}/csv", {
          params: { path: { rideId } },
          parseAs: "blob",
        })
      : await api.GET("/api/v1/rides/{rideId}/gpx", {
          params: { path: { rideId } },
          parseAs: "blob",
        });
  if (!response.ok || !data) {
    throw new Error(`Export failed (${response.status})`);
  }
  saveBlob(data, `tarmoto-ride-${rideId}.${format}`);
}

export async function downloadAllRidesExport(
  format: RideExportFormat,
  now: Date = new Date(),
): Promise<void> {
  const { data, response } =
    format === "csv"
      ? await api.GET("/api/v1/rides/export.csv", { parseAs: "blob" })
      : await api.GET("/api/v1/rides/export.gpx", { parseAs: "blob" });
  if (!response.ok || !data) {
    throw new Error(`Export failed (${response.status})`);
  }
  const stamp = now.toISOString().slice(0, 10);
  saveBlob(data, `tarmoto-rides-${stamp}.${format}`);
}
