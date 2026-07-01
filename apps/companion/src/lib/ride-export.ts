import { API_BASE } from "@/lib/config";
import { useAuthStore } from "@/stores/auth";

export type RideExportFormat = "csv" | "gpx";

interface DownloadArgs {
  path: string;
  filename: string;
}

async function download({ path, filename }: DownloadArgs): Promise<void> {
  const token = useAuthStore.getState().accessToken;
  const res = await fetch(`${API_BASE}${path}`, {
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
  });
  if (!res.ok) {
    throw new Error(`Export failed (${res.status})`);
  }
  const blob = await res.blob();
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

export function downloadRideExport(
  rideId: string,
  format: RideExportFormat,
): Promise<void> {
  return download({
    path: `/rides/${rideId}/${format}`,
    filename: `tarmoto-ride-${rideId}.${format}`,
  });
}

export function downloadAllRidesExport(
  format: RideExportFormat,
  now: Date = new Date(),
): Promise<void> {
  const stamp = now.toISOString().slice(0, 10);
  return download({
    path: `/rides/export.${format}`,
    filename: `tarmoto-rides-${stamp}.${format}`,
  });
}
