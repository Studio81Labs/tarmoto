/**
 * Trip folders — client-side metadata with localStorage persistence.
 *
 * The backend has no folder table yet, but `Trip.folderId` already exists and
 * is persisted via `tripsApi.update`. So we treat folders as user-local
 * metadata: the folder *row* (id → name) lives in localStorage keyed per user,
 * while the assignment (`trip.folderId`) is server state. When the backend
 * introduces a folders endpoint this module can switch storage without
 * touching consumers.
 */

export interface TripFolder {
  id: string;
  name: string;
  createdAt: string;
}

const STORAGE_PREFIX = "tarmoto:trip-folders:";

export const MAX_FOLDER_NAME_LENGTH = 60;

export function storageKey(userId: string): string {
  return `${STORAGE_PREFIX}${userId}`;
}

export function loadFolders(userId: string): TripFolder[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isFolder);
  } catch {
    return [];
  }
}

export function saveFolders(userId: string, folders: TripFolder[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(userId), JSON.stringify(folders));
  } catch {
    // Quota or private-mode failures are non-fatal; folders simply won't
    // persist across sessions. The in-memory state still works.
  }
}

function isFolder(value: unknown): value is TripFolder {
  if (!value || typeof value !== "object") return false;
  const f = value as Record<string, unknown>;
  return (
    typeof f.id === "string" &&
    typeof f.name === "string" &&
    typeof f.createdAt === "string"
  );
}

export function validateFolderName(
  name: string,
  folders: readonly TripFolder[],
  excludeId?: string,
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Folder name is required";
  if (trimmed.length > MAX_FOLDER_NAME_LENGTH) {
    return `Folder name must be ${MAX_FOLDER_NAME_LENGTH} characters or fewer`;
  }
  const lower = trimmed.toLowerCase();
  const clash = folders.some(
    (f) => f.id !== excludeId && f.name.trim().toLowerCase() === lower,
  );
  if (clash) return "A folder with that name already exists";
  return null;
}

// Validation (uniqueness, length) is handled at the call site via
// `validateFolderName`. This helper just mints the record.
export function createFolder(name: string, now: Date = new Date()): TripFolder {
  return {
    id: generateFolderId(now),
    name: name.trim(),
    createdAt: now.toISOString(),
  };
}

export function renameFolder(
  folders: readonly TripFolder[],
  id: string,
  name: string,
): TripFolder[] {
  return folders.map((f) => (f.id === id ? { ...f, name: name.trim() } : f));
}

export function removeFolder(
  folders: readonly TripFolder[],
  id: string,
): TripFolder[] {
  return folders.filter((f) => f.id !== id);
}

export function sortFoldersByName(
  folders: readonly TripFolder[],
): TripFolder[] {
  return folders
    .slice()
    .sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
}

// Short time-based id with a random suffix — unique enough for client-local
// metadata and deterministic across the two calls we make per create (id +
// createdAt are both derived from `now`).
function generateFolderId(now: Date): string {
  const ts = now.getTime().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `fld_${ts}_${rand}`;
}
