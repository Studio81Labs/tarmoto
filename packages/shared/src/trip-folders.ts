/**
 * US-37 — wire shape for the rider-owned trip folder rows persisted by
 * `apps/backend/src/modules/trip-folders/`.
 *
 * Snake_case to mirror the backend response so consumers (companion +
 * mobile) can deserialise without an extra adapter. `color` is an
 * optional CSS hex string ("#22d3ee"); the server stores it verbatim
 * and clients render the swatch directly.
 */
export interface TripFolder {
  id: string;
  user_id: string;
  name: string;
  color: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

export const MAX_TRIP_FOLDER_NAME_LENGTH = 120;
