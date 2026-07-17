"use client";

import { Suspense, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { DiscoverMap } from "./_components/DiscoverMap";
import { ZoneListPanel } from "./_components/ZoneListPanel";
import { ZoneDetailPanel } from "./_components/ZoneDetailPanel";
import {
  useDiscoverStore,
  type DiscoverBbox,
} from "./_components/useDiscoverStore";
import type { FunZoneListItem } from "@/lib/discover";

function DiscoverPageInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const {
    center,
    zoom,
    drawnBbox,
    selectedZoneId,
    setCenter,
    setZoom,
    setDrawnBbox,
    clearDrawnBbox,
    setSelectedZoneId,
  } = useDiscoverStore();

  const [zones, setZones] = useState<FunZoneListItem[]>([]);
  const [zonesLoading, setZonesLoading] = useState(true);
  const [zonesError, setZonesError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  // Hydrate store from URL once per searchParams snapshot.
  // `hydrated` is state (not a ref) so the sync effect waits for the render
  // that follows the store update — otherwise it would read stale store
  // values from the same commit and overwrite the URL with defaults.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    const lng = numberParam(searchParams.get("lng"));
    const lat = numberParam(searchParams.get("lat"));
    const z = numberParam(searchParams.get("z"));
    if (lng != null && lat != null) setCenter({ lng, lat });
    if (z != null) setZoom(z);

    const bboxStr = searchParams.get("bbox");
    const bbox = parseBbox(bboxStr);
    if (bbox) {
      setDrawnBbox(bbox);
    } else {
      // Missing OR malformed bbox param — clear any drawn state we might
      // have carried over so the UI matches the URL.
      clearDrawnBbox();
    }

    const zoneId = searchParams.get("zone");
    setSelectedZoneId(zoneId);

    setHydrated(true);
    // Intentionally only runs when the URL changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Reflect store back into the URL without scrolling or pushing history.
  useEffect(() => {
    if (!hydrated) return;
    const next = new URLSearchParams();
    next.set("lng", center.lng.toFixed(5));
    next.set("lat", center.lat.toFixed(5));
    next.set("z", zoom.toFixed(2));
    if (drawnBbox)
      next.set("bbox", drawnBbox.map((n) => n.toFixed(5)).join(","));
    if (selectedZoneId) next.set("zone", selectedZoneId);

    const current = searchParams.toString();
    if (next.toString() === current) return;
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, {
      scroll: false,
    });
  }, [
    hydrated,
    center.lng,
    center.lat,
    zoom,
    drawnBbox,
    selectedZoneId,
    pathname,
    router,
    searchParams,
  ]);

  const summary = selectedZoneId
    ? (zones.find((z) => z.id === selectedZoneId) ?? null)
    : null;

  return (
    <div className="flex h-full overflow-hidden">
      <ZoneListPanel
        zones={zones}
        loading={zonesLoading}
        error={zonesError}
        onRetry={() => {
          setZonesError(null);
          setRetryNonce((n) => n + 1);
        }}
      />
      <div className="flex-1 relative bg-cream">
        <DiscoverMap
          retryNonce={retryNonce}
          onZonesLoaded={(next) => {
            setZones(next);
            setZonesError(null);
          }}
          onZonesLoading={setZonesLoading}
          onZonesError={setZonesError}
        />
      </div>
      <ZoneDetailPanel summary={summary} />
    </div>
  );
}

function numberParam(value: string | null): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseBbox(raw: string | null): DiscoverBbox | null {
  if (!raw) return null;
  const parts = raw.split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [w, s, e, n] = parts;
  if (
    w === undefined ||
    s === undefined ||
    e === undefined ||
    n === undefined
  ) {
    return null;
  }
  if (!(w < e && s < n)) return null;
  return [w, s, e, n];
}

export default function DiscoverPage() {
  return (
    <Suspense fallback={null}>
      <DiscoverPageInner />
    </Suspense>
  );
}
