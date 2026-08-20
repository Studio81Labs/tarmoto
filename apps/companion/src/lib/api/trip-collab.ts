import type { components } from "@tarmoto/openapi-client";
import { api, openApiData, reqSignal } from "./client";
import type { JsonResponse, JsonRequest } from "./client";

// ── Trip collaboration (US-35: suggestions + votes + accept/reject + activity) ──

export type TripSuggestion = components["schemas"]["SuggestionDto"];
export type SuggestionVote = NonNullable<TripSuggestion["caller_vote"]>;
export type SuggestionStatus = TripSuggestion["status"];

// The backend types the activity `payload` as an opaque, action-specific
// object, which the generated spec collapses to `Record<string, never>` —
// unusable for the feed renderer that reads `payload.title`, `payload.vote`,
// `payload.role`, etc. Widen just that one field to `unknown`-valued at the
// boundary (the spec can't express the discriminated-by-`action` shape);
// everything else stays generated.
export type TripActivityEntry = Omit<
  components["schemas"]["TripActivityEntryDto"],
  "payload"
> & { payload: Record<string, unknown> };
export type TripActivityAction =
  components["schemas"]["TripActivityEntryDto"]["action"];
export type TripActivityListResponse =
  components["schemas"]["TripActivityListResponseDto"];

export const tripCollabApi = {
  listSuggestions: (tripId: string) =>
    openApiData<TripSuggestion[]>(
      api.GET("/api/v1/trips/{tripId}/suggestions", {
        params: { path: { tripId } },
      }),
    ),
  createSuggestion: (
    tripId: string,
    payload: JsonRequest<"/api/v1/trips/{tripId}/suggestions", "post">,
  ) =>
    openApiData<TripSuggestion>(
      api.POST("/api/v1/trips/{tripId}/suggestions", {
        params: { path: { tripId } },
        body: payload,
      }),
    ),
  deleteSuggestion: (tripId: string, suggestionId: string) =>
    openApiData<void>(
      api.DELETE("/api/v1/trips/{tripId}/suggestions/{suggestionId}", {
        params: { path: { tripId, suggestionId } },
      }),
    ),
  voteSuggestion: (
    tripId: string,
    suggestionId: string,
    vote: SuggestionVote,
  ) =>
    openApiData<TripSuggestion>(
      api.POST("/api/v1/trips/{tripId}/suggestions/{suggestionId}/vote", {
        params: { path: { tripId, suggestionId } },
        body: { vote },
      }),
    ),
  unvoteSuggestion: (tripId: string, suggestionId: string) =>
    openApiData<TripSuggestion>(
      api.DELETE("/api/v1/trips/{tripId}/suggestions/{suggestionId}/vote", {
        params: { path: { tripId, suggestionId } },
      }),
    ),
  acceptSuggestion: (tripId: string, suggestionId: string) =>
    openApiData<TripSuggestion>(
      api.POST("/api/v1/trips/{tripId}/suggestions/{suggestionId}/accept", {
        params: { path: { tripId, suggestionId } },
      }),
    ),
  rejectSuggestion: (tripId: string, suggestionId: string) =>
    openApiData<TripSuggestion>(
      api.POST("/api/v1/trips/{tripId}/suggestions/{suggestionId}/reject", {
        params: { path: { tripId, suggestionId } },
      }),
    ),
  /** Flip a resolved suggestion back to `open` (owner/admin only). */
  reopenSuggestion: (tripId: string, suggestionId: string) =>
    openApiData<TripSuggestion>(
      api.POST("/api/v1/trips/{tripId}/suggestions/{suggestionId}/reopen", {
        params: { path: { tripId, suggestionId } },
      }),
    ),
  listActivity: (tripId: string, limit?: number) =>
    openApiData<TripActivityListResponse>(
      api.GET("/api/v1/trips/{tripId}/activity", {
        params: {
          path: { tripId },
          query: limit != null ? { limit } : {},
        },
      }),
    ),
  /**
   * Email a trip invite to a recipient (they don't need an account yet).
   * The backend queues the mail best-effort and always answers `queued`,
   * records a pending-invite row, and mints a personal invite code for
   * the mail's join link. Re-inviting the same address updates the role
   * and rotates the code.
   */
  invite: (
    tripId: string,
    payload: JsonRequest<"/api/v1/trips/{tripId}/invite", "post">,
  ) =>
    openApiData<JsonResponse<"/api/v1/trips/{tripId}/invite", "post", 202>>(
      api.POST("/api/v1/trips/{tripId}/invite", {
        params: { path: { tripId } },
        body: payload,
      }),
    ),
  /** Roster: joined members + (owner/editor only) pending invites. */
  listMembers: (tripId: string) =>
    openApiData<TripCollaborators>(
      api.GET("/api/v1/trips/{tripId}/members", {
        params: { path: { tripId } },
      }),
    ),
  updateMemberRole: (
    tripId: string,
    memberUserId: string,
    role: AssignableTripRole,
  ) =>
    openApiData<TripCollaborators>(
      api.PATCH("/api/v1/trips/{tripId}/members/{memberUserId}", {
        params: { path: { tripId, memberUserId } },
        body: { role },
      }),
    ),
  removeMember: (tripId: string, memberUserId: string) =>
    openApiData<void>(
      api.DELETE("/api/v1/trips/{tripId}/members/{memberUserId}", {
        params: { path: { tripId, memberUserId } },
      }),
    ),
  /** Self-removal for a collaborator (viewer/editor) — the owner has no leave path.
   *  `init` carries an abort signal so the planner's kill switch can cancel a
   *  leave still in flight (#1163). */
  leaveTrip: (tripId: string, init?: RequestInit) =>
    openApiData<void>(
      api.DELETE("/api/v1/trips/{tripId}/members/me", {
        params: { path: { tripId } },
        ...reqSignal(init),
      }),
    ),
  revokeInvite: (tripId: string, inviteId: string) =>
    openApiData<void>(
      api.DELETE("/api/v1/trips/{tripId}/invites/{inviteId}", {
        params: { path: { tripId, inviteId } },
      }),
    ),
};

// ── Collaborator roster (People tab) ──

export type TripCollaborators = components["schemas"]["TripCollaboratorsDto"];
export type TripCollaboratorMember =
  components["schemas"]["TripCollaboratorMemberDto"];
export type TripPendingInvite = components["schemas"]["TripPendingInviteDto"];
export type TripMemberRole = TripCollaboratorMember["role"];
export type AssignableTripRole =
  components["schemas"]["UpdateTripMemberRoleDto"]["role"];
