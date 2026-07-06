import { apiFetch } from "./client";

// ── Trip folders (US-37: rider-owned folders that sync across devices) ──

export interface TripFolderResponse {
  id: string;
  user_id: string;
  name: string;
  color: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface TripFolderListResponse {
  items: TripFolderResponse[];
  total: number;
}

export interface CreateTripFolderInput {
  name: string;
  color?: string | null;
}

export interface UpdateTripFolderInput {
  name?: string;
  color?: string | null;
  position?: number;
}

export const tripFoldersApi = {
  list: () => apiFetch<TripFolderListResponse>("/trip-folders"),
  create: (input: CreateTripFolderInput) =>
    apiFetch<TripFolderResponse>("/trip-folders", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  update: (id: string, input: UpdateTripFolderInput) =>
    apiFetch<TripFolderResponse>(`/trip-folders/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  delete: (id: string) =>
    apiFetch<void>(`/trip-folders/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
};
