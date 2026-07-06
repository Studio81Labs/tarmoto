import { apiFetch } from "./client";

// ── Trip collaboration (US-35: suggestions + votes + accept/reject + activity) ──

export type SuggestionVote = "up" | "down";
export type SuggestionStatus = "open" | "accepted" | "rejected";

export interface TripSuggestion {
  id: string;
  trip_id: string;
  trip_day_id: string | null;
  suggested_by: string;
  suggester_display_name: string;
  road_segment_id: string | null;
  title: string;
  description: string | null;
  lat: number | null;
  lng: number | null;
  status: SuggestionStatus;
  up_votes: number;
  down_votes: number;
  /** Caller's own vote, or null if they haven't voted. */
  caller_vote: SuggestionVote | null;
  created_at: string;
  updated_at: string;
}

export type TripActivityAction =
  | "member_joined"
  | "member_left"
  | "member_invited"
  | "trip_updated"
  | "trip_generated"
  | "suggestion_created"
  | "suggestion_deleted"
  | "suggestion_voted"
  | "suggestion_vote_removed"
  | "suggestion_accepted"
  | "suggestion_rejected"
  | "suggestion_reopened"
  | "member_removed"
  | "member_role_changed";

export interface TripActivityEntry {
  id: string;
  trip_id: string;
  actor_id: string | null;
  actor_name: string | null;
  action: TripActivityAction;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface TripActivityListResponse {
  activity: TripActivityEntry[];
}

export const tripCollabApi = {
  listSuggestions: (tripId: string) =>
    apiFetch<TripSuggestion[]>(
      `/trips/${encodeURIComponent(tripId)}/suggestions`,
    ),
  createSuggestion: (
    tripId: string,
    payload: {
      title: string;
      description?: string;
      trip_day_id?: string;
      road_segment_id?: string;
      lat?: number;
      lng?: number;
    },
  ) =>
    apiFetch<TripSuggestion>(
      `/trips/${encodeURIComponent(tripId)}/suggestions`,
      { method: "POST", body: JSON.stringify(payload) },
    ),
  deleteSuggestion: (tripId: string, suggestionId: string) =>
    apiFetch<void>(
      `/trips/${encodeURIComponent(tripId)}/suggestions/${encodeURIComponent(suggestionId)}`,
      { method: "DELETE" },
    ),
  voteSuggestion: (
    tripId: string,
    suggestionId: string,
    vote: SuggestionVote,
  ) =>
    apiFetch<TripSuggestion>(
      `/trips/${encodeURIComponent(tripId)}/suggestions/${encodeURIComponent(suggestionId)}/vote`,
      { method: "POST", body: JSON.stringify({ vote }) },
    ),
  unvoteSuggestion: (tripId: string, suggestionId: string) =>
    apiFetch<TripSuggestion>(
      `/trips/${encodeURIComponent(tripId)}/suggestions/${encodeURIComponent(suggestionId)}/vote`,
      { method: "DELETE" },
    ),
  acceptSuggestion: (tripId: string, suggestionId: string) =>
    apiFetch<TripSuggestion>(
      `/trips/${encodeURIComponent(tripId)}/suggestions/${encodeURIComponent(suggestionId)}/accept`,
      { method: "POST" },
    ),
  rejectSuggestion: (tripId: string, suggestionId: string) =>
    apiFetch<TripSuggestion>(
      `/trips/${encodeURIComponent(tripId)}/suggestions/${encodeURIComponent(suggestionId)}/reject`,
      { method: "POST" },
    ),
  /** Flip a resolved suggestion back to `open` (owner/admin only). */
  reopenSuggestion: (tripId: string, suggestionId: string) =>
    apiFetch<TripSuggestion>(
      `/trips/${encodeURIComponent(tripId)}/suggestions/${encodeURIComponent(suggestionId)}/reopen`,
      { method: "POST" },
    ),
  listActivity: (tripId: string, limit?: number) => {
    const query = limit != null ? `?limit=${limit}` : "";
    return apiFetch<TripActivityListResponse>(
      `/trips/${encodeURIComponent(tripId)}/activity${query}`,
    );
  },
  /**
   * Email a trip invite to a recipient (they don't need an account yet).
   * The backend queues the mail best-effort and always answers `queued`,
   * records a pending-invite row, and mints a personal invite code for
   * the mail's join link. Re-inviting the same address updates the role
   * and rotates the code.
   */
  invite: (
    tripId: string,
    payload: { email: string; message?: string; role?: AssignableTripRole },
  ) =>
    apiFetch<{ status: "queued" }>(
      `/trips/${encodeURIComponent(tripId)}/invite`,
      { method: "POST", body: JSON.stringify(payload) },
    ),
  /** Roster: joined members + (owner/editor only) pending invites. */
  listMembers: (tripId: string) =>
    apiFetch<TripCollaborators>(`/trips/${encodeURIComponent(tripId)}/members`),
  updateMemberRole: (
    tripId: string,
    memberUserId: string,
    role: AssignableTripRole,
  ) =>
    apiFetch<TripCollaborators>(
      `/trips/${encodeURIComponent(tripId)}/members/${encodeURIComponent(memberUserId)}`,
      { method: "PATCH", body: JSON.stringify({ role }) },
    ),
  removeMember: (tripId: string, memberUserId: string) =>
    apiFetch<void>(
      `/trips/${encodeURIComponent(tripId)}/members/${encodeURIComponent(memberUserId)}`,
      { method: "DELETE" },
    ),
  revokeInvite: (tripId: string, inviteId: string) =>
    apiFetch<void>(
      `/trips/${encodeURIComponent(tripId)}/invites/${encodeURIComponent(inviteId)}`,
      { method: "DELETE" },
    ),
};

// ── Collaborator roster (People tab) ──

export type TripMemberRole = "owner" | "editor" | "viewer";
export type AssignableTripRole = "editor" | "viewer";

export interface TripCollaboratorMember {
  user_id: string;
  display_name: string;
  /** Only present for owner/editor callers — null for viewers. */
  email: string | null;
  avatar_url: string | null;
  role: TripMemberRole;
  joined_at: string;
  state: "joined";
}

export interface TripPendingInvite {
  id: string;
  email: string;
  role: string;
  created_at: string;
  state: "invited";
}

export interface TripCollaborators {
  members: TripCollaboratorMember[];
  invites: TripPendingInvite[];
}
