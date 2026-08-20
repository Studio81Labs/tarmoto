"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import type { components } from "@tarmoto/openapi-client";
import { tileTokenRotationMs } from "@tarmoto/shared";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";

type MintedTileToken = components["schemas"]["TileTokenResponseDto"];

/** Keyed by rider: a second account signing in on the same browser must not
 *  inherit the previous one's cached credential. */
export const TILE_TOKEN_QUERY_KEY = (userId: string | null) =>
  ["tile-token", userId] as const;

/** Treat a token as spent slightly early so a request in flight when it
 *  expires is not the one that discovers it. */
const EXPIRY_SKEW_MS = 5_000;

let currentToken: string | null = null;
let currentExpiryMs = 0;

/**
 * The live tile credential, or `null` when there is none — signed out, not
 * fetched yet, or expired.
 *
 * SYNCHRONOUS on purpose: MapLibre's `transformRequest` cannot await, so the
 * credential has to be readable from a module-level cell rather than a hook.
 * `null` is always a valid answer (the tile is then fetched anonymously and
 * the backend clamps quality to the free tier), which is what keeps a rotation
 * gap from failing tiles.
 */
export function getTileToken(): string | null {
  if (currentToken === null) return null;
  if (Date.now() >= currentExpiryMs) return null;
  return currentToken;
}

function setTileToken(token: string | null, expiresInSeconds: number): void {
  currentToken = token;
  currentExpiryMs =
    token === null ? 0 : Date.now() + expiresInSeconds * 1000 - EXPIRY_SKEW_MS;
}

/** Test seam: the module cell outlives a component tree, so a suite that
 *  renders a signed-in map would otherwise leak its token into the next one. */
export function __resetTileTokenForTest(): void {
  currentToken = null;
  currentExpiryMs = 0;
}

async function mintTileToken(signal: AbortSignal): Promise<MintedTileToken> {
  const { data, error } = await api.POST("/api/v1/roads/tiles/token", {
    signal,
  });
  if (error || !data) throw new Error("Failed to mint a tile token");
  return data;
}

/**
 * Keeps {@link getTileToken} supplied while the rider is signed in (#1279).
 *
 * Mounted by `MapCanvas`, so every map surface inherits it and the shared
 * query key collapses concurrent maps onto one mint. Signed-out visitors never
 * fetch: the query is disabled and the tiles stay anonymous, which is exactly
 * the free view they are entitled to.
 *
 * A failed refetch deliberately does NOT clear the token in hand — react-query
 * keeps the last successful data, so a transient outage rides out on the
 * existing credential and only the expiry in `getTileToken` retires it. That
 * is the difference between a blip and a map that drops to the free zoom cap
 * every time the network hiccups.
 *
 * Returns whether a credential is currently in hand, so a map can notice the
 * moment its tiles stopped — or started — being fetched as this rider. See
 * `MapCanvas`, which reloads its quality source on that transition rather than
 * leaving anonymously-fetched (free-capped) tiles in MapLibre's cache.
 */
export function useTileTokenSync(): boolean {
  const accessToken = useAuthStore((s) => s.accessToken);
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const signedIn = Boolean(accessToken);

  // Explicit generic: `staleTime` / `refetchInterval` read `query.state.data`,
  // which makes TanStack's inference of the query data circular and collapses
  // it to `{}` when left implicit.
  const { data } = useQuery<MintedTileToken>({
    queryKey: TILE_TOKEN_QUERY_KEY(userId),
    enabled: signedIn,
    // The token is only useful while a map is on screen, and it rotates on its
    // own schedule — no background wakeups, but pick a fresh one up when the
    // rider comes back to a tab that slept through a rotation.
    refetchOnWindowFocus: true,
    staleTime: (query) =>
      query.state.data ? tileTokenRotationMs(query.state.data.expires_in) : 0,
    refetchInterval: (query) =>
      query.state.data
        ? tileTokenRotationMs(query.state.data.expires_in)
        : false,
    queryFn: ({ signal }) => mintTileToken(signal),
  });

  useEffect(() => {
    // Clearing on `!data` is safe BECAUSE react-query retains the last success
    // through a failed refetch: `data` only goes undefined when the query key
    // changes (a different rider) or the cache is reset — precisely when the
    // credential in hand stops being this rider's. Sign-out lands here too, and
    // must retire the token immediately: cached query data outlives a session.
    if (!signedIn || !data) {
      setTileToken(null, 0);
      return;
    }
    setTileToken(data.token, data.expires_in);
  }, [signedIn, data]);

  return signedIn && Boolean(data);
}
