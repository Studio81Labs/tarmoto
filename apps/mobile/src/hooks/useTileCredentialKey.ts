import { useSyncExternalStore } from "react";
import {
  getTileCredentialPresence,
  subscribeTileCredentialPresence,
} from "@/services/tileAuth";

/**
 * A key fragment that changes when backend tile requests start — or stop —
 * carrying this rider's credential (#1279).
 *
 * Fold it into a `VectorSource`'s `key` so the source REMOUNTS on that
 * transition. MapLibre caches a fetched tile by its coordinates, and adding the
 * native URL transform later changes neither the source's URL template nor its
 * cache key, so without this a source that fetched z13+ tiles before the mint
 * landed keeps serving those anonymous (free-capped) tiles indefinitely — a
 * paying rider's overlay simply missing until an unrelated remount. It is the
 * mobile counterpart of `MapCanvas`'s identity-change `setTiles` reload, which
 * RN MapLibre has no equivalent of.
 *
 * Scoped to the credential's PRESENCE, not its value: a rotation replaces one
 * live token with another and needs no remount — those tiles were already
 * fetched as this rider.
 */
export function useTileCredentialKey(): string {
  const present = useSyncExternalStore(
    subscribeTileCredentialPresence,
    getTileCredentialPresence,
    getTileCredentialPresence,
  );
  return present ? "authed" : "anon";
}
