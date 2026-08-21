"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import type { components } from "@tarmoto/openapi-client";
import { TILE_TOKEN_MINT_RETRY_MS, tileTokenRotationMs } from "@tarmoto/shared";
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
/** The RIDER whose credential the tile requests currently carry, or `null`
 *  for none. An id, not a boolean: see `setCredentialIdentity`. */
let credentialIdentity: string | null = null;
const presenceListeners = new Set<() => void>();

/**
 * Publish WHOSE credential the tile requests currently carry.
 *
 * This is the signal `MapCanvas` reloads its quality source on. Two things it
 * must not be:
 *
 *  - **Not react-query's `data`.** That survives a failed refetch by design, so
 *    a data-driven signal would stay live right through an outage and the
 *    anonymously-fetched (free-capped) tiles cached during it would never be
 *    reloaded once a fresh credential landed. Expiry is detected in
 *    `getTileToken` instead, on read.
 *  - **Not a boolean.** A direct rider A → rider B switch, where B's token is
 *    still in TanStack's cache, never passes through "no credential" — so a
 *    presence flag would stay `true` across it and the source would keep tiles
 *    fetched under A: a free B seeing A's paid deep zoom, or a paid B stuck
 *    with A's clamped empty tiles. The identity changes even when presence
 *    does not.
 */
function setCredentialIdentity(next: string | null): void {
  if (next === credentialIdentity) return;
  credentialIdentity = next;
  for (const listener of presenceListeners) listener();
}

function subscribeCredentialIdentity(listener: () => void): () => void {
  presenceListeners.add(listener);
  return () => presenceListeners.delete(listener);
}

function getCredentialIdentity(): string | null {
  return credentialIdentity;
}

/** SSR snapshot: the server never holds a credential, and MapLibre only runs
 *  in the browser, so there is nothing to hydrate a mismatch from. */
function getServerCredentialIdentity(): string | null {
  return null;
}

/**
 * The live tile credential, or `null` when there is none — signed out, not
 * fetched yet, or expired.
 *
 * SYNCHRONOUS on purpose: MapLibre's `transformRequest` cannot await, so the
 * credential has to be readable from a module-level cell rather than a hook.
 * `null` is always a valid answer (the tile is then fetched anonymously and
 * the backend clamps quality to the free tier), which is what keeps a rotation
 * gap from failing tiles.
 *
 * Expiry is detected HERE, on read, and published — there is no timer to trust
 * and a tab can sleep through one. Safe to notify from: the only caller is the
 * request transform, never a React render.
 */
export function getTileToken(): string | null {
  if (currentToken === null) return null;
  if (Date.now() >= currentExpiryMs) {
    setCredentialIdentity(null);
    return null;
  }
  return currentToken;
}

/**
 * `mintedAtMs` is when the token was ISSUED, not when it was adopted — the two
 * differ whenever react-query hands back cached data (a map remount inside the
 * gc window, or the same rider signing back in against a retained query). Timing
 * the lifetime from adoption would silently renew an old token's local deadline,
 * so `getTileToken` would go on appending an already-expired JWT and, worse,
 * keep reporting the credential as present — the backend would serve deep-zoom
 * tiles anonymously without ever triggering the source reload.
 */
function setTileToken(
  token: string | null,
  expiresInSeconds: number,
  mintedAtMs: number,
  riderId: string | null,
): void {
  currentToken = token;
  currentExpiryMs =
    token === null ? 0 : mintedAtMs + expiresInSeconds * 1000 - EXPIRY_SKEW_MS;
  const live = token !== null && Date.now() < currentExpiryMs;
  setCredentialIdentity(live ? riderId : null);
}

/** Test seam: the module cell outlives a component tree, so a suite that
 *  renders a signed-in map would otherwise leak its token into the next one. */
export function __resetTileTokenForTest(): void {
  currentToken = null;
  currentExpiryMs = 0;
  // Notify rather than drop the listener set: clearing it would orphan any
  // still-mounted subscriber instead of telling it the credential is gone.
  setCredentialIdentity(null);
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
 * Returns WHOSE credential the tiles are currently being fetched with (`null`
 * for none), so a map can notice the moment that changes. See `MapCanvas`,
 * which reloads its quality source on any change rather than leaving another
 * rider's — or anonymously-fetched, free-capped — tiles in MapLibre's cache.
 * The signal comes from the credential itself rather than from the query data,
 * so an expiry the refetch has not yet replaced registers too.
 */
export function useTileTokenSync(): string | null {
  const accessToken = useAuthStore((s) => s.accessToken);
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const signedIn = Boolean(accessToken);

  // Explicit generic: `staleTime` / `refetchInterval` read `query.state.data`,
  // which makes TanStack's inference of the query data circular and collapses
  // it to `{}` when left implicit.
  const { data, dataUpdatedAt } = useQuery<MintedTileToken>({
    queryKey: TILE_TOKEN_QUERY_KEY(userId),
    enabled: signedIn,
    // The token is only useful while a map is on screen, and it rotates on its
    // own schedule — no background wakeups, but pick a fresh one up when the
    // rider comes back to a tab that slept through a rotation.
    refetchOnWindowFocus: true,
    staleTime: (query) =>
      query.state.data ? tileTokenRotationMs(query.state.data.expires_in) : 0,
    // Rotation cadence only while the last fetch actually SUCCEEDED. Otherwise
    // it is a retry cadence, and both halves of that matter:
    //  - no data at all (a failed FIRST mint) would leave nothing to schedule
    //    from, so the query would stop polling entirely and the rider would
    //    fetch tiles anonymously until an unrelated reconnect or remount;
    //  - data but a failed rotation is the subtler one — react-query retains
    //    the last success, so scheduling from it would wait another full
    //    rotation. With a 15-minute token an outage that outlives the retry
    //    budget at minute nine but clears at minute eleven would leave the map
    //    anonymous until minute eighteen, three of them past the expiry.
    // `fetchFailureCount` resets to 0 on success, so this returns to the
    // rotation cadence by itself.
    refetchInterval: (query) =>
      query.state.data && query.state.fetchFailureCount === 0
        ? tileTokenRotationMs(query.state.data.expires_in)
        : TILE_TOKEN_MINT_RETRY_MS,
    queryFn: ({ signal }) => mintTileToken(signal),
  });

  useEffect(() => {
    // Clearing on `!data` is safe BECAUSE react-query retains the last success
    // through a failed refetch: `data` only goes undefined when the query key
    // changes (a different rider) or the cache is reset — precisely when the
    // credential in hand stops being this rider's. Sign-out lands here too, and
    // must retire the token immediately: cached query data outlives a session.
    if (!signedIn || !data) {
      setTileToken(null, 0, 0, null);
      return;
    }
    // `dataUpdatedAt` is when THIS token was written into the cache, so a
    // cached one keeps its original deadline instead of being renewed here.
    setTileToken(data.token, data.expires_in, dataUpdatedAt, userId);
  }, [signedIn, data, dataUpdatedAt, userId]);

  return useSyncExternalStore(
    subscribeCredentialIdentity,
    getCredentialIdentity,
    getServerCredentialIdentity,
  );
}
