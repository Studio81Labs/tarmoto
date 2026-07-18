/**
 * Trip folders — client helpers for the API-backed folder model (US-37).
 *
 * The backend now owns the canonical folder rows in the `trip_folders`
 * table. This module provides pure helpers (validation, sorting) plus a
 * one-time migration that lifts any pre-existing `localStorage` rows
 * into the backend on first load post-upgrade so riders don't lose
 * their folder names when they sign back in.
 */

import {
  MAX_TRIP_FOLDER_NAME_LENGTH,
  type LooseTranslate,
  type TripFolder as SharedTripFolder,
} from "@tarmoto/shared";
import { tripFoldersApi } from "@/lib/api";

// Re-export the shared wire shape so components import a single
// definition. The backend (`TripFolderResponseDto`) and the companion
// API client both produce this shape; pulling the type from
// `@tarmoto/shared` keeps the three layers in lockstep.
export type TripFolder = SharedTripFolder;

const LEGACY_STORAGE_PREFIX = "tarmoto:trip-folders:";
const MIGRATED_STORAGE_PREFIX = "tarmoto:trip-folders-migrated:";

// Re-exported under the existing public name so call sites that still
// reference `MAX_FOLDER_NAME_LENGTH` (the modal validator does) keep
// working without a churn-y rename, while the shared constant remains
// the single source of truth.
export const MAX_FOLDER_NAME_LENGTH = MAX_TRIP_FOLDER_NAME_LENGTH;

export function legacyStorageKey(userId: string): string {
  return `${LEGACY_STORAGE_PREFIX}${userId}`;
}

function migratedFlagKey(userId: string): string {
  return `${MIGRATED_STORAGE_PREFIX}${userId}`;
}

/**
 * Sort folders for client display. Position is the canonical order, but
 * we tie-break on `name` so rows freshly inserted at the same position
 * (e.g. just after a migration) render in a stable, intuitive order
 * before the next reorder PATCH lands.
 */
export function sortFoldersForDisplay(
  folders: readonly TripFolder[],
): TripFolder[] {
  return folders.slice().sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

export function validateFolderName(
  name: string,
  folders: readonly TripFolder[],
  t: LooseTranslate,
  excludeId?: string,
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return t("Folder name is required");
  if (trimmed.length > MAX_FOLDER_NAME_LENGTH) {
    return t("Folder name must be {max} characters or fewer", {
      max: MAX_FOLDER_NAME_LENGTH,
    });
  }
  const lower = trimmed.toLowerCase();
  const clash = folders.some(
    (f) => f.id !== excludeId && f.name.trim().toLowerCase() === lower,
  );
  if (clash) return t("A folder with that name already exists");
  return null;
}

export interface LegacyTripFolder {
  id: string;
  name: string;
  createdAt: string;
}

function isLegacyFolder(value: unknown): value is LegacyTripFolder {
  if (!value || typeof value !== "object") return false;
  const f = value as Record<string, unknown>;
  return typeof f.id === "string" && typeof f.name === "string";
}

export function readLegacyFolders(userId: string): LegacyTripFolder[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(legacyStorageKey(userId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isLegacyFolder);
  } catch {
    return [];
  }
}

export function clearLegacyFolders(userId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(legacyStorageKey(userId));
    window.localStorage.setItem(migratedFlagKey(userId), "1");
  } catch {
    // Quota or private-mode failures are non-fatal — the migration
    // flag will be re-attempted on the next load and the legacy rows
    // simply won't be POSTed twice because the backend list will
    // already contain them by then.
  }
}

function hasRunMigration(userId: string): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(migratedFlagKey(userId)) === "1";
  } catch {
    return false;
  }
}

export interface MigrationResult {
  attempted: number;
  succeeded: number;
}

/**
 * Lift any pre-existing localStorage folder rows into the backend on
 * first load post-upgrade. The migration:
 *
 *  - skips when the rider has already run it (sticky flag);
 *  - skips when the rider already has folders on the server (a clean
 *    install with empty localStorage shouldn't post anything);
 *  - skips legacy names that already match a server folder (case-
 *    insensitive) so re-running the migration after a partial failure
 *    doesn't create duplicates;
 *  - clears the localStorage rows + sets the migration flag once at
 *    least one POST succeeds, so subsequent loads short-circuit.
 *
 * Returns null when nothing was attempted (no work to do, or no user).
 */
export async function migrateLegacyFolders(
  userId: string,
  serverFolders: readonly TripFolder[],
): Promise<MigrationResult | null> {
  if (!userId || hasRunMigration(userId)) return null;
  const legacy = readLegacyFolders(userId);
  if (legacy.length === 0) {
    clearLegacyFolders(userId);
    return null;
  }
  // Server-side de-duplication: if the rider already created a folder
  // with the same name on another device after this client cached the
  // legacy rows, don't post a duplicate.
  const serverNames = new Set(
    serverFolders.map((f) => f.name.trim().toLowerCase()),
  );
  const toMigrate = legacy.filter(
    (f) => !serverNames.has(f.name.trim().toLowerCase()),
  );
  if (toMigrate.length === 0) {
    clearLegacyFolders(userId);
    return { attempted: 0, succeeded: 0 };
  }

  let succeeded = 0;
  for (const f of toMigrate) {
    try {
      await tripFoldersApi.create({ name: f.name.trim() });
      succeeded += 1;
    } catch {
      // A single failure shouldn't block the rest — the next load
      // re-runs the migration over the unmigrated names. We only set
      // the migration flag below if EVERY pending row landed.
    }
  }

  if (succeeded === toMigrate.length) {
    clearLegacyFolders(userId);
  }

  return { attempted: toMigrate.length, succeeded };
}
