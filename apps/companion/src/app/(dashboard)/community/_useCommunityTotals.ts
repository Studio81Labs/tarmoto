"use client";
import { useEffect, useState } from "react";
import { communityApi, routeCollectionsApi } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";

/**
 * Lightweight community-feed total for the shared `CommunityScaffold`
 * tab badge. Hits `/rides/community?limit=1` so the total comes back
 * without fetching the full grid (the active feed page passes its own
 * total through the scaffold to avoid double-fetching).
 *
 * Gated on auth-store hydration so the request doesn't race AuthSync
 * — same pattern as `useRidesTotal`, `useRidesQuery`, `useUserTrips`.
 */
export function useCommunityFeedTotal(): number | null {
  const authReady = useAuthStore((s) => Boolean(s.accessToken));
  const [total, setTotal] = useState<number | null>(null);
  useEffect(() => {
    if (!authReady) return;
    let cancelled = false;
    communityApi
      .list({ limit: 1, offset: 0 })
      .then(({ data }) => {
        if (cancelled) return;
        setTotal(data.total ?? 0);
      })
      .catch(() => {
        // Silent: tab badge is decorative; leaving it as null hides it.
      });
    return () => {
      cancelled = true;
    };
  }, [authReady]);
  return total;
}

/**
 * Lightweight collections total for the shared `CommunityScaffold`
 * tab badge. `/collections/me` returns the rider's own list; the
 * count is the length. The active collections page passes its own
 * count through the scaffold so this hook only fires on the sibling
 * tab.
 */
export function useCommunityCollectionsTotal(): number | null {
  const authReady = useAuthStore((s) => Boolean(s.accessToken));
  const [total, setTotal] = useState<number | null>(null);
  useEffect(() => {
    if (!authReady) return;
    let cancelled = false;
    routeCollectionsApi
      .listMine()
      .then(({ data }) => {
        if (cancelled) return;
        setTotal(data.items?.length ?? 0);
      })
      .catch(() => {
        // Silent.
      });
    return () => {
      cancelled = true;
    };
  }, [authReady]);
  return total;
}
