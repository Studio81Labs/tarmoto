"use client";

import { useTranslation } from "@/i18n/I18nProvider";
import {
  getUserFacingErrorMessage,
  type EnglishMessageKey,
  type Translate,
} from "@/i18n";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  Check,
  ChevronDown,
  Copy,
  Power,
  Star,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Users,
  X,
} from "lucide-react";
import {
  ApiError,
  tripCollabApi,
  tripSharesApi,
  type AssignableTripRole,
  type TripActivityEntry,
  type TripCollaborators,
  type TripMemberRole,
  type TripShareResponse,
  type TripSuggestion,
} from "@/lib/api";
import { onTripActivity } from "@/lib/socket";
import type { Trip } from "@/lib/types";
import {
  formatRelativeTimeLabel,
  type SubscriptionTier,
} from "@tarmoto/shared";
import { tripSnapshotForSharing } from "@/lib/trip-snapshot";
import { useEntitlements, useFeature, useLimit } from "@/hooks";
import { UpgradePrompt } from "@/components/entitlements/UpgradePrompt";
import {
  isFeatureForbiddenError,
  parseFeatureLimitError,
} from "@/lib/entitlements";
import {
  Button,
  CopyField,
  Input,
  Select,
  Textarea,
  Toggle,
} from "@tarmoto/ui";
import { UserAvatar } from "@/components/UserAvatar";
import { useFormat } from "@/format/FormatProvider";
import {
  SUGGESTION_STATUS_LABELS,
  translateKnownLabel,
} from "@/i18n/domainLabels";
type Tab = "invite" | "people" | "suggestions" | "activity";
// Progressive disclosure page sizes: both lists render newest-first and
// grow unbounded within a session (suggestions are fetched whole because
// the map overlay needs every marker; activity merges live socket
// entries on top of the fetched page). Cards are tall, so suggestions
// page smaller than the compact activity rows.
const SUGGESTIONS_PAGE_SIZE = 5;
const ACTIVITY_PAGE_SIZE = 10;
interface TripCollaborateModalProps {
  open: boolean;
  trip: Trip | null;
  serverTripId?: string | null;
  currentUserId?: string | null;
  ownerId?: string | null;
  canCreateInviteLink?: boolean;
  /**
   * Shared suggestions state from the planner page's
   * `useTripCollabSession`. When supplied, the tab reads/mutates this
   * single source of truth (one fetch, one listener) so the map overlay
   * and modal stay in sync. Leave undefined for standalone tests.
   */
  suggestions?: TripSuggestion[];
  onSuggestionsChange?: React.Dispatch<React.SetStateAction<TripSuggestion[]>>;
  /**
   * Error message from the shared `listSuggestions` fetch, if any. When
   * the modal uses external state, the fetch happens in the hook and
   * its failures need to surface here so they don't get rendered as a
   * misleading empty-state message.
   */
  suggestionsError?: string | null;
  onPromoted?: (serverTripId: string) => void;
  /**
   * "suggestions" opens a stripped dialog with only the Suggestions
   * surface (no tab bar, no invite/people/activity) — the header
   * "Suggestions" button for viewers/editors. Defaults to the full
   * collaborate dialog.
   */
  mode?: "full" | "suggestions";
  onClose: () => void;
}
/**
 * US-35 — full collaboration surface for trip planning. Sits on top of
 * the suggestions/voting REST surface from `#250` and adds cursor
 * broadcast + activity log + accept/reject from `#251`.
 *
 * Tabs:
 *   • Invite       — group-link toggle (create/revoke, from `#249`)
 *                    plus email invites for saved trips.
 *   • Suggestions  — propose / vote / owner accept/reject / delete.
 *   • Activity     — reverse-chronological who-did-what timeline.
 */
export function TripCollaborateModal({
  open,
  trip,
  serverTripId = null,
  currentUserId = null,
  ownerId = null,
  canCreateInviteLink: explicitCanCreateInviteLink,
  suggestions: externalSuggestions,
  onSuggestionsChange,
  suggestionsError: externalSuggestionsError = null,
  onPromoted,
  mode = "full",
  onClose,
}: TripCollaborateModalProps) {
  const t = useTranslation();
  const format = useFormat();
  const suggestionsOnly = mode === "suggestions";
  const [tab, setTab] = useState<Tab>(
    suggestionsOnly ? "suggestions" : "invite",
  );
  const [share, setShare] = useState<TripShareResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [collaborators, setCollaborators] = useState<TripCollaborators | null>(
    null,
  );
  const sessionRef = useRef(0);
  const onCloseRef = useRef(onClose);
  const canCreateInviteLink =
    explicitCanCreateInviteLink ?? serverTripId === null;
  // SP1 gates `collaborative_trips` (Pro) on the backend ONLY for a share
  // attached to a PERSISTED trip (`dto.trip_id` set) — a snapshot-only
  // preview share for an unsaved draft (`trip_id: null`) stays open to every
  // tier. Mirror that split here: the entitlement only matters once a trip
  // is actually saved to the server.
  const isPersistedTrip = Boolean(serverTripId);
  const { tier, refetch: refetchEntitlements } = useEntitlements();
  const {
    enabled: collabTripsEnabled,
    isError: collabTripsError,
    isSuccess: collabTripsResolved,
    dataUpdatedAt: collabDataUpdatedAt,
  } = useFeature("collaborative_trips");
  // Fail closed while unresolved-and-not-errored (avoids a locked-state
  // flash), and once resolved to disabled. An entitlement lookup ERROR does
  // NOT block indefinitely — defer to the backend (authoritative) and catch
  // the resulting 403 in the reactive net below, mirroring the gpx-export
  // precedent in `RideExportMenu`.
  const collabTripsGateActive =
    isPersistedTrip &&
    ((!collabTripsResolved && !collabTripsError) ||
      (collabTripsResolved && !collabTripsEnabled));
  // Only show the upsell once the lookup has actually RESOLVED to
  // not-entitled — never during the unresolved window (that would flash).
  const collabTripsBlocked =
    isPersistedTrip && collabTripsResolved && !collabTripsEnabled;
  const [collabUpgradeOpen, setCollabUpgradeOpen] = useState(false);
  // Clear the reactive share-create upsell on the genuine "became granted"
  // transition (a /users/me refresh restored collaborative_trips, or an
  // operator re-enabled it) so the modal doesn't keep blocking the
  // collaboration surface with a stale "Limit reached" once the action is
  // allowed again — mirrors the People-tab toggleForbidden recovery. Keyed on
  // the transition (not a plain "is granted") so a same-render race-403 that
  // set it isn't self-cleared.
  const prevCollabGrantedRef = useRef(false);
  // `dataUpdatedAt` recorded when the reactive upsell opened — so we can detect
  // a FRESH successful snapshot arriving afterward even when the granted flag
  // never changes (the "already-granted race").
  const upsellOpenedAtRef = useRef(0);
  const openCollabUpsell = useCallback(() => {
    upsellOpenedAtRef.current = collabDataUpdatedAt;
    setCollabUpgradeOpen(true);
    // Pull a fresh /users/me so the upsell self-corrects promptly instead of
    // waiting for the 5-min poll or a refocus.
    refetchEntitlements();
  }, [collabDataUpdatedAt, refetchEntitlements]);
  useEffect(() => {
    const isGranted = collabTripsResolved && collabTripsEnabled;
    const wasGranted = prevCollabGrantedRef.current;
    prevCollabGrantedRef.current = isGranted;
    if (!collabUpgradeOpen) return;
    // Clear on the disabled→enabled transition OR when a FRESH snapshot arrives
    // after the upsell opened and confirms the feature is granted (the
    // already-granted race: enabled was true throughout, so no transition
    // fires, but a later successful refetch — dataUpdatedAt advanced — confirms
    // the action is now allowed and this upsell is stale).
    const becameGranted = isGranted && !wasGranted;
    const freshGrantedSnapshot =
      isGranted && collabDataUpdatedAt > upsellOpenedAtRef.current;
    if (becameGranted || freshGrantedSnapshot) setCollabUpgradeOpen(false);
  }, [
    collabTripsResolved,
    collabTripsEnabled,
    collabDataUpdatedAt,
    collabUpgradeOpen,
  ]);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    sessionRef.current += 1;
    setShare(null);
    setError(null);
    setCopied(false);
    setLoading(false);
    setCollaborators(null);
    // Clear the reactive-403 upgrade dialog too: the modal stays mounted with
    // open={false} between sessions, so a stale `collabUpgradeOpen` would
    // otherwise re-surface on the next open — possibly for a different trip or
    // after entitlements changed.
    setCollabUpgradeOpen(false);
    setTab(suggestionsOnly ? "suggestions" : "invite");
  }, [open, suggestionsOnly]);
  useEffect(() => {
    if (!open) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onCloseRef.current();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open]);
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 2500);
    return () => window.clearTimeout(id);
  }, [copied]);
  // Rehydrate the group-link toggle from the server. Share state is
  // reset on every open, but a share created in an earlier session
  // still exists — without this the toggle would render OFF next to a
  // live link, and switching it on would mint a duplicate share row.
  // Only possible for saved trips: local-draft shares carry
  // `trip_id: null`, so there is nothing reliable to match them on.
  useEffect(() => {
    if (!open || !trip || !canCreateInviteLink || !serverTripId) return;
    const session = sessionRef.current;
    (async () => {
      try {
        const { data } = await tripSharesApi.listMine();
        if (session !== sessionRef.current) return;
        const existing = data.items.find((s) => s.trip_id === serverTripId);
        // Functional update: if the user toggled the link on while this
        // fetch was in flight, keep the share they just created.
        if (existing) setShare((prev) => prev ?? existing);
      } catch (err) {
        if (session !== sessionRef.current) return;
        setError(describeError(err, t));
      }
    })();
  }, [t, open, trip, canCreateInviteLink, serverTripId]);
  const handleGenerate = useCallback(async () => {
    if (!trip || !canCreateInviteLink) return;
    // Proactive gate: don't fire a persisted-trip share create the backend
    // will 403 on `collaborative_trips`. A snapshot-only share (no saved
    // trip) is never gated — `collabTripsGateActive` is false whenever
    // `serverTripId` is null.
    if (collabTripsGateActive) {
      setCollabUpgradeOpen(true);
      return;
    }
    const session = sessionRef.current;
    setLoading(true);
    setError(null);
    try {
      const { data } = await tripSharesApi.create({
        title: trip.name || t("Untitled trip"),
        snapshot: tripSnapshotForSharing(trip) as unknown as Record<
          string,
          unknown
        >,
        trip_id: serverTripId,
      });
      if (session !== sessionRef.current) return;
      setShare(data);
    } catch (err) {
      if (session !== sessionRef.current) return;
      // Reactive net for a persisted-trip share: a revoke between the
      // entitlement snapshot and this call would otherwise surface a raw
      // 403 as generic error text.
      // Only route to the upsell modal when we actually know the tier — the
      // modal renders under `collabUpgradeOpen && tier`, so opening it with a
      // null tier (the /users/me lookup-error path that left the gate
      // deferring to the backend) would swallow the 403 into a silent
      // no-op. Fall back to the visible error in that case.
      if (serverTripId && tier && isFeatureForbiddenError(err)) {
        openCollabUpsell();
      } else {
        setError(describeError(err, t));
      }
    } finally {
      if (session === sessionRef.current) setLoading(false);
    }
  }, [
    t,
    canCreateInviteLink,
    collabTripsGateActive,
    openCollabUpsell,
    serverTripId,
    tier,
    trip,
  ]);
  const handleRevoke = useCallback(async () => {
    if (!share) return;
    const session = sessionRef.current;
    setLoading(true);
    setError(null);
    try {
      await tripSharesApi.revoke(share.id);
      if (session !== sessionRef.current) return;
      setShare(null);
      setCopied(false);
    } catch (err) {
      if (session !== sessionRef.current) return;
      setError(describeError(err, t));
    } finally {
      if (session === sessionRef.current) setLoading(false);
    }
  }, [t, share]);
  const handleCopy = useCallback(async () => {
    if (!share) return;
    const url = buildInviteUrl(share.share_token);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setError(t("Copy failed — select the URL manually."));
    }
  }, [t, share]);
  // "Revoke & regenerate": invalidate the current group link and mint a
  // fresh one in a single action. The old token stops resolving the
  // moment the revoke lands; only then is the new share created so a
  // failure can't leave two live links.
  const handleRegenerate = useCallback(async () => {
    if (!trip || !share) return;
    // Same proactive gate as `handleGenerate` — regenerate re-mints the
    // persisted-trip share, which the backend gates identically.
    if (collabTripsGateActive) {
      setCollabUpgradeOpen(true);
      return;
    }
    const session = sessionRef.current;
    setLoading(true);
    setError(null);
    try {
      try {
        await tripSharesApi.revoke(share.id);
      } catch (revokeErr) {
        if (session !== sessionRef.current) return;
        // The revoke's own 403 is TripSharesService.revoke's owner-only
        // authorization check, NOT the collaborative_trips feature gate — so
        // surface it as a plain error and keep the (still-live) link rather
        // than a misleading upgrade prompt for a non-owner editor.
        setError(describeError(revokeErr, t));
        return;
      }
      // The old token stops resolving the instant the revoke lands. Drop it
      // from state NOW so that if the subsequent create fails (e.g. a
      // collaborative_trips revoke raced this action and 403s), the UI doesn't
      // keep presenting the dead link as an active invite.
      if (session !== sessionRef.current) return;
      setShare(null);
      const { data } = await tripSharesApi.create({
        title: trip.name || t("Untitled trip"),
        snapshot: tripSnapshotForSharing(trip) as unknown as Record<
          string,
          unknown
        >,
        trip_id: serverTripId,
      });
      if (session !== sessionRef.current) return;
      setShare(data);
      setCopied(false);
    } catch (err) {
      // Only the CREATE reaches here now (the revoke is handled above), so a
      // feature 403 IS the collaborative_trips gate. Route to the upsell only
      // when we know the tier — the modal renders under `collabUpgradeOpen &&
      // tier`, so opening it with a null tier (the /users/me lookup-error path)
      // would swallow the 403 silently; fall back to the visible error then.
      if (session !== sessionRef.current) return;
      if (serverTripId && tier && isFeatureForbiddenError(err)) {
        openCollabUpsell();
      } else {
        setError(describeError(err, t));
      }
    } finally {
      if (session === sessionRef.current) setLoading(false);
    }
  }, [
    t,
    collabTripsGateActive,
    openCollabUpsell,
    serverTripId,
    share,
    tier,
    trip,
  ]);
  // Roster (People tab + the count badge). Fetched once per open for
  // saved trips; PeopleTab mutations refresh it via this callback.
  const refreshCollaborators = useCallback(async () => {
    if (!serverTripId) return;
    const session = sessionRef.current;
    try {
      const { data } = await tripCollabApi.listMembers(serverTripId);
      if (session !== sessionRef.current) return;
      setCollaborators(data);
    } catch (err) {
      if (session !== sessionRef.current) return;
      setError(describeError(err, t));
    }
  }, [t, serverTripId]);
  useEffect(() => {
    if (!open || !serverTripId) return;
    void refreshCollaborators();
  }, [open, serverTripId, refreshCollaborators]);
  if (!open) return null;
  const inviteUrl = share ? buildInviteUrl(share.share_token) : null;
  const isOwner = Boolean(
    currentUserId && ownerId && currentUserId === ownerId,
  );
  const callerRole: TripMemberRole | null =
    collaborators?.members.find((m) => m.user_id === currentUserId)?.role ??
    (isOwner ? "owner" : null);
  const peopleCount = collaborators
    ? collaborators.members.length + collaborators.invites.length
    : null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="trip-collaborate-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 backdrop-blur-sm p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[86vh] w-full max-w-[500px] flex-col overflow-hidden rounded-2xl border border-line-strong bg-cream shadow-[0_24px_60px_rgba(20,17,14,0.32)]">
        <div className="shrink-0 border-b border-line px-5 pb-3.5 pt-[18px]">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <Users size={15} className="shrink-0 text-accent" />
                <h2
                  id="trip-collaborate-title"
                  className="font-sans text-[19px] font-extrabold leading-[1.05] tracking-[-0.5px] text-ink"
                >
                  {suggestionsOnly
                    ? t("Suggestions")
                    : t("Collaborate on this trip")}
                </h2>
              </div>
              <p className="mt-1.5 max-w-[380px] text-[12.5px] leading-normal text-fg-dim">
                {suggestionsOnly
                  ? t(
                      "Propose route changes, vote on your group's ideas, and follow which ones get accepted.",
                    )
                  : t(
                      "Share a group link, gather route suggestions from your riders, and track the activity log.",
                    )}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={t("Close dialog")}
              className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-line-strong text-fg-dim transition hover:text-ink"
            >
              <X size={14} />
            </button>
          </div>
          {!suggestionsOnly && (
            <nav
              role="tablist"
              aria-label={t("Collaboration tabs")}
              className="mt-4 flex gap-[22px]"
            >
              {(
                [
                  { id: "invite", label: "Invite link" },
                  { id: "people", label: "People", badge: peopleCount },
                  { id: "suggestions", label: "Suggestions" },
                  { id: "activity", label: "Activity" },
                ] as {
                  id: Tab;
                  label: EnglishMessageKey;
                  badge?: number | null;
                }[]
              ).map(({ id, label, badge }) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  onClick={() => {
                    // Clear any parent-level error on tab change so an
                    // invite-tab failure doesn't bleed into Suggestions /
                    // Activity where the message is out of context.
                    setError(null);
                    setTab(id);
                  }}
                  className={
                    "relative flex items-center gap-1.5 pb-2.5 text-[13.5px] font-bold transition " +
                    (tab === id ? "text-ink" : "text-fg-mute hover:text-ink")
                  }
                >
                  {t(label)}
                  {badge != null && badge > 0 && (
                    <span className="rounded-full bg-accent px-1.5 py-px font-mono text-[9px] font-bold text-cream">
                      {format.integer(badge)}
                    </span>
                  )}
                  {tab === id && (
                    <span
                      aria-hidden="true"
                      className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-accent"
                    />
                  )}
                </button>
              ))}
            </nav>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {tab === "invite" && (
            <InviteTab
              trip={trip}
              serverTripId={serverTripId}
              share={share}
              loading={loading}
              copied={copied}
              inviteUrl={inviteUrl}
              canCreateInviteLink={canCreateInviteLink}
              collabTripsGateActive={collabTripsGateActive}
              collabTripsBlocked={collabTripsBlocked}
              tier={tier}
              onGenerate={handleGenerate}
              onRevoke={handleRevoke}
              onRegenerate={handleRegenerate}
              onCopy={handleCopy}
            />
          )}

          {tab === "people" && (
            <PeopleTab
              trip={trip}
              serverTripId={serverTripId}
              currentUserId={currentUserId}
              isOwner={isOwner}
              callerRole={callerRole}
              collaborators={collaborators}
              onChanged={refreshCollaborators}
              onPromoted={onPromoted}
            />
          )}

          {tab === "suggestions" && (
            <SuggestionsTab
              trip={trip}
              serverTripId={serverTripId}
              currentUserId={currentUserId}
              isOwner={isOwner}
              callerRole={callerRole}
              hideProposeIntro={suggestionsOnly}
              externalSuggestions={externalSuggestions}
              onExternalChange={onSuggestionsChange}
              externalError={externalSuggestionsError}
              onPromoted={onPromoted}
            />
          )}

          {tab === "activity" && (
            <ActivityTab
              trip={trip}
              serverTripId={serverTripId}
              onPromoted={onPromoted}
            />
          )}

          {error && <ErrorAlert className="mt-4">{error}</ErrorAlert>}
        </div>
      </div>

      {collabUpgradeOpen && tier ? (
        <UpgradePrompt
          variant="modal"
          capability={{ feature: "collaborative_trips" }}
          currentTier={tier}
          message={t("Sharing an invite link for a saved trip needs Pro.")}
          onClose={() => setCollabUpgradeOpen(false)}
        />
      ) : null}
    </div>
  );
}
function InviteTab({
  trip,
  serverTripId,
  share,
  loading,
  copied,
  inviteUrl,
  canCreateInviteLink,
  collabTripsGateActive,
  collabTripsBlocked,
  tier,
  onGenerate,
  onRevoke,
  onRegenerate,
  onCopy,
}: {
  trip: Trip | null;
  serverTripId: string | null;
  share: TripShareResponse | null;
  loading: boolean;
  copied: boolean;
  inviteUrl: string | null;
  canCreateInviteLink: boolean;
  /** True while a persisted-trip share create/regenerate must not fire —
   *  either the `collaborative_trips` lookup hasn't resolved yet (fail
   *  closed) or it resolved to disabled. Always false for a snapshot-only
   *  share (no `serverTripId`) — that path is never gated. */
  collabTripsGateActive: boolean;
  /** `collabTripsGateActive`, narrowed to the RESOLVED-and-disabled case —
   *  only then is it safe to show the upsell without a locked-state flash. */
  collabTripsBlocked: boolean;
  tier: SubscriptionTier | null;
  onGenerate: () => void;
  onRevoke: () => void;
  onRegenerate: () => void;
  onCopy: () => void;
}) {
  const t = useTranslation();
  if (!trip) {
    return (
      <HintBox>
        {t("Generate or load a trip first to create an invite link.")}
      </HintBox>
    );
  }
  if (!canCreateInviteLink) {
    return (
      <HintBox>
        {t("Only trip owners and admins can create invite links.")}
      </HintBox>
    );
  }
  return (
    <div>
      <div className="mb-3.5 flex items-center justify-between gap-3 rounded-[11px] border border-line bg-cream px-3.5 py-[13px]">
        <div>
          <div className="text-[13.5px] font-bold text-ink">
            {t("Group link")}
          </div>
          <div className="mt-0.5 text-[11.5px] text-fg-dim">
            {share
              ? t("Anyone with the link can preview")
              : t("Link sharing is off")}
          </div>
        </div>
        <Toggle
          checked={share !== null}
          // Only the CREATE direction (turning the link on) needs the
          // entitlement — revoking an existing share is never gated, so a
          // rider who was downgraded after generating one can still turn it
          // off.
          disabled={loading || (share === null && collabTripsGateActive)}
          ariaLabel={t("Group link")}
          onChange={(next) => (next ? onGenerate() : onRevoke())}
        />
      </div>

      {collabTripsBlocked && tier ? (
        <div className="mb-3.5">
          <UpgradePrompt
            variant="inline"
            capability={{ feature: "collaborative_trips" }}
            currentTier={tier}
            message={t("Sharing an invite link for a saved trip needs Pro.")}
          />
        </div>
      ) : null}

      {share ? (
        <>
          <span className="mb-2 block font-mono text-[10px] font-bold uppercase tracking-[1.6px] text-fg-dim">
            {t("Invite link")}
          </span>
          <div className="flex gap-2">
            <CopyField
              value={inviteUrl ?? ""}
              ariaLabel={t("Shareable invite URL")}
              copyLabel={t("Copy invite link")}
              onCopied={onCopy}
              className="min-w-0 flex-1"
            />
            <Button
              variant="accent"
              size="md"
              uppercase
              onClick={onCopy}
              leftIcon={copied ? <Check size={14} /> : <Copy size={14} />}
            >
              {copied ? t("Copied") : t("Copy")}
            </Button>
          </div>
          <p className="mt-2.5 text-[11.5px] leading-normal text-fg-mute">
            {serverTripId
              ? t(
                  "Anyone with the link can preview the trip. Signed-in riders can join it and open the planner to suggest changes or vote.",
                )
              : t(
                  "Anyone with the link can view a read-only preview of this trip. Save the trip to the server to let riders join and collaborate.",
                )}
          </p>

          <div className="my-[18px] h-px bg-line" />

          <div className="flex items-center justify-between gap-3 rounded-[11px] border border-quality-q1/30 bg-quality-q1/5 px-3.5 py-[13px]">
            <div className="flex min-w-0 items-start gap-2.5">
              <Power size={14} className="mt-0.5 shrink-0 text-quality-q1" />
              <div className="min-w-0">
                <div className="text-[13px] font-bold text-ink">
                  {t("Revoke & regenerate link")}
                </div>
                <div className="mt-0.5 text-[11.5px] leading-normal text-fg-dim">
                  {t(
                    "Generates a new link and invalidates the current one. Pending link-invitees will need the new link.",
                  )}
                </div>
              </div>
            </div>
            <Button
              variant="danger"
              size="sm"
              className="shrink-0"
              disabled={loading || collabTripsGateActive}
              onClick={onRegenerate}
            >
              {t("Revoke")}
            </Button>
          </div>
        </>
      ) : collabTripsBlocked ? null : (
        <div className="rounded-[10px] border border-dashed border-line-strong px-4 py-5 text-center text-[12.5px] leading-normal text-fg-mute">
          {serverTripId
            ? t(
                "Turn link sharing on to generate a group invite link. Existing collaborators keep their access.",
              )
            : t(
                "Turn link sharing on to generate a read-only preview link. Riders can join and collaborate once the trip is saved to the server.",
              )}
        </div>
      )}
    </div>
  );
}
/**
 * People tab — the collaborator roster. Merges joined members and
 * (owner/editor view) pending email invites into one list; the owner
 * manages roles / removals through the per-row menu.
 */
function PeopleTab({
  trip,
  serverTripId,
  currentUserId,
  isOwner,
  callerRole,
  collaborators,
  onChanged,
  onPromoted,
}: {
  trip: Trip | null;
  serverTripId: string | null;
  currentUserId: string | null;
  isOwner: boolean;
  callerRole: TripMemberRole | null;
  collaborators: TripCollaborators | null;
  onChanged: () => Promise<void> | void;
  onPromoted?: ((id: string) => void) | undefined;
}) {
  const t = useTranslation();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AssignableTripRole>("editor");
  const [inviting, setInviting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [upgradeErr, setUpgradeErr] = useState<number | null>(null);
  const { tier, refetch: refetchEntitlements } = useEntitlements();
  const {
    limit: collabLimit,
    isError: limitError,
    isSuccess: limitResolved,
  } = useLimit("max_trip_collaborators");
  // `collaborative_trips` (Pro toggle) gates the email invite too: the backend
  // guards `POST /trips/:tripId/invite` with @RequireFeature. PeopleTab only
  // runs for a persisted trip (see the `!serverTripId` early return below), so
  // this is always the gated case — no snapshot-only carve-out applies here.
  // Fail closed while unresolved (but defer to the backend on a lookup ERROR,
  // matching the cap gate, so an owner isn't stuck with no feedback).
  const {
    enabled: collabTripsEnabled,
    isError: collabTripsError,
    isSuccess: collabTripsResolved,
    dataUpdatedAt: collabDataUpdatedAt,
  } = useFeature("collaborative_trips");
  const collabTripsGateActive =
    (!collabTripsResolved && !collabTripsError) ||
    (collabTripsResolved && !collabTripsEnabled);
  const collabTripsBlocked = collabTripsResolved && !collabTripsEnabled;
  const [toggleForbidden, setToggleForbidden] = useState(false);
  const toggleForbiddenAtRef = useRef(0);
  const flagToggleForbidden = useCallback(() => {
    toggleForbiddenAtRef.current = collabDataUpdatedAt;
    setToggleForbidden(true);
    refetchEntitlements();
  }, [collabDataUpdatedAt, refetchEntitlements]);
  // A reactive-403 upsell must not outlive the condition that caused it. Clear
  // it on the genuine "became granted" transition (a foreground refresh or an
  // operator re-enabling the flag) OR when a FRESH snapshot arrives after the
  // upsell was set and confirms the feature is granted (the already-granted
  // race: enabled was true throughout, so no transition fires, but a later
  // successful refetch — dataUpdatedAt advanced — confirms the action is now
  // allowed). Keyed on the transition/fresh-snapshot, not a plain "is granted",
  // so a same-render race-403 isn't self-cleared into a silent failure.
  const prevCollabGrantedRef = useRef(false);
  useEffect(() => {
    const isGranted = collabTripsResolved && collabTripsEnabled;
    const wasGranted = prevCollabGrantedRef.current;
    prevCollabGrantedRef.current = isGranted;
    if (!toggleForbidden) return;
    const becameGranted = isGranted && !wasGranted;
    const freshGrantedSnapshot =
      isGranted && collabDataUpdatedAt > toggleForbiddenAtRef.current;
    if (becameGranted || freshGrantedSnapshot) setToggleForbidden(false);
  }, [
    collabTripsResolved,
    collabTripsEnabled,
    collabDataUpdatedAt,
    toggleForbidden,
  ]);
  if (!serverTripId) {
    return (
      <PromoteTripCTA
        trip={trip}
        onPromoted={onPromoted}
        headline={t("Inviting people needs a saved trip")}
        body={t(
          "Save this trip to the server to invite riders by email and manage who can edit or view.",
        )}
      />
    );
  }
  const handleInvite = async () => {
    const recipient = email.trim();
    if (!recipient) return;
    setInviting(true);
    setError(null);
    setNotice(null);
    // Clear any prior toggle-forbidden upsell before retrying — a success on
    // this attempt (the flag was restored) must not leave the stale prompt up.
    setToggleForbidden(false);
    try {
      await tripCollabApi.invite(serverTripId, { email: recipient, role });
      setEmail("");
      setNotice(t("Invite sent to {email}.", { email: recipient }));
      await onChanged();
    } catch (err) {
      const limitError = parseFeatureLimitError(err);
      if (limitError) {
        setUpgradeErr(limitError.limit);
      } else if (isFeatureForbiddenError(err) && tier) {
        // A plain collaborative_trips 403 (no FEATURE_LIMIT_EXCEEDED body) —
        // e.g. the proactive gate deferred on a lookup error, or a revoke
        // raced the request. Show the toggle upsell, not a raw error. Guard
        // on a known tier so we never surface a dead-end (no-CTA) prompt.
        flagToggleForbidden();
      } else {
        setError(describeError(err, t));
      }
    } finally {
      setInviting(false);
    }
  };
  const handleRoleChange = async (
    memberUserId: string,
    nextRole: AssignableTripRole,
  ) => {
    setError(null);
    try {
      await tripCollabApi.updateMemberRole(
        serverTripId,
        memberUserId,
        nextRole,
      );
      await onChanged();
    } catch (err) {
      setError(describeError(err, t));
    }
  };
  const handleRemoveMember = async (memberUserId: string) => {
    setError(null);
    try {
      await tripCollabApi.removeMember(serverTripId, memberUserId);
      await onChanged();
    } catch (err) {
      setError(describeError(err, t));
    }
  };
  const handleRevokeInvite = async (inviteId: string) => {
    setError(null);
    try {
      await tripCollabApi.revokeInvite(serverTripId, inviteId);
      await onChanged();
    } catch (err) {
      setError(describeError(err, t));
    }
  };
  const total = collaborators
    ? collaborators.members.length + collaborators.invites.length
    : 0;
  // Roster count EXCLUDES the owner — the backend cap is "collaborators
  // per trip, excluding the owner", but `total` above (members + invites)
  // includes the owner's own member row.
  const nonOwnerCount = collaborators
    ? collaborators.members.filter((m) => m.role !== "owner").length +
      collaborators.invites.length
    : 0;
  // Proactive gate is authoritative only for the OWNER (the cap is the
  // owner's tier, and `useEntitlements` only reflects the CURRENT user).
  // Fail closed while the cap is UNRESOLVED (loading / rolling-deploy omission)
  // and block when it has RESOLVED to an exceeded finite cap. But if the
  // entitlement lookup ERRORED, do NOT block indefinitely with no feedback:
  // let the invite hit the backend, which is the authority and returns a 403
  // the modal surfaces below (an owner is otherwise stuck with a disabled
  // button and no explanation or retry).
  const atCollaboratorCap =
    isOwner &&
    ((!limitResolved && !limitError) ||
      (limitResolved && collabLimit !== null && nonOwnerCount >= collabLimit));
  // A re-invite of an already-pending address is net-zero (role change / code
  // rotation) — the backend exempts it from the cap, so the UI must not block
  // it even when the owner is at the limit. Email identity normalization must
  // stay stable across UI locales, matching the auth boundary.
  // eslint-disable-next-line tarmoto-localization/no-locale-insensitive-search
  const trimmedEmail = email.trim().toLowerCase();
  const isReinviteOfPending =
    collaborators?.invites.some(
      // eslint-disable-next-line tarmoto-localization/no-locale-insensitive-search
      (inv) => inv.email.toLowerCase() === trimmedEmail,
    ) ?? false;
  const inviteBlockedByCap = atCollaboratorCap && !isReinviteOfPending;
  // Editors can send email invites too (the backend treats them as
  // privileged senders); role management and removal stay owner-only.
  const canInvite = isOwner || callerRole === "editor";
  return (
    <div>
      {canInvite && (
        <div className="mb-4 rounded-xl border border-line bg-paper p-3.5">
          <div className="mb-2 text-[13px] font-extrabold text-ink">
            {t("Invite people")}
          </div>
          <div className="flex gap-2">
            <Input
              tone="cream"
              type="email"
              value={email}
              onChange={setEmail}
              placeholder={t("rider@email.com")}
              ariaLabel={t("Invite email address")}
              maxLength={255}
              className="min-w-0 flex-1"
            />
            <Select
              tone="cream"
              value={role}
              onChange={(value) => setRole(value as AssignableTripRole)}
              ariaLabel={t("Invite role")}
              className="w-auto shrink-0"
              options={[
                { value: "editor", label: t("Editor") },
                { value: "viewer", label: t("Viewer") },
              ]}
            />
            <Button
              variant="accent"
              size="md"
              uppercase
              loading={inviting}
              disabled={
                inviting ||
                !email.trim() ||
                inviteBlockedByCap ||
                collabTripsGateActive
              }
              onClick={handleInvite}
            >
              {t("Invite")}
            </Button>
          </div>
          {notice && (
            <p className="mt-2 text-[11.5px] text-[#1f8a5b]">{notice}</p>
          )}
          {(collabTripsBlocked || toggleForbidden) && tier ? (
            <div className="mt-3">
              <UpgradePrompt
                variant="inline"
                capability={{ feature: "collaborative_trips" }}
                currentTier={tier}
                message={t("Inviting collaborators to a trip needs Pro.")}
              />
            </div>
          ) : atCollaboratorCap && tier && collabLimit !== null ? (
            <div className="mt-3">
              <p className="mb-2 text-[12.5px] text-ink/70">
                {t("{count} of {max} collaborators", {
                  count: nonOwnerCount,
                  max: collabLimit,
                })}
              </p>
              <UpgradePrompt
                variant="inline"
                capability={{
                  limit: "max_trip_collaborators",
                  resolvedLimit: collabLimit,
                }}
                currentTier={tier}
                message={t(
                  "You've reached the collaborator limit for this trip.",
                )}
              />
            </div>
          ) : null}
        </div>
      )}

      {collaborators && (
        <>
          <div className="mb-2.5 flex items-center justify-between">
            <span className="font-mono text-[9.5px] uppercase tracking-[0.6px] text-fg-mute">
              {t("On this trip")}
            </span>
            <span className="font-mono text-[9.5px] uppercase text-fg-mute">
              {t("{count, plural, one {# person} other {# people}}", {
                count: total,
              })}
            </span>
          </div>
          <ul className="flex flex-col gap-1">
            {collaborators.members.map((member) => {
              const isSelf = member.user_id === currentUserId;
              return (
                <li
                  key={member.user_id}
                  className="flex items-center gap-3 px-1.5 py-2.5"
                >
                  <UserAvatar
                    name={isSelf ? t("You") : member.display_name}
                    avatarUrl={member.avatar_url}
                    size={34}
                    fontSize={11}
                    accent={isSelf}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-bold text-ink">
                      {isSelf ? t("You") : member.display_name}
                    </div>
                    {member.email && !isSelf && (
                      <div className="mt-px truncate font-mono text-[9.5px] text-fg-mute">
                        {member.email}
                      </div>
                    )}
                  </div>
                  {member.role === "owner" ? (
                    <span className="shrink-0 px-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.4px] text-accent">
                      {t("Owner")}
                    </span>
                  ) : isOwner ? (
                    <RoleMenu
                      role={member.role as AssignableTripRole}
                      label={isSelf ? t("You") : member.display_name}
                      onRoleChange={(next) =>
                        handleRoleChange(member.user_id, next)
                      }
                      onRemove={() => handleRemoveMember(member.user_id)}
                    />
                  ) : (
                    <span className="shrink-0 px-1.5 text-xs font-bold capitalize text-fg-dim">
                      {member.role === "editor" ? t("Editor") : t("Viewer")}
                    </span>
                  )}
                </li>
              );
            })}
            {collaborators.invites.map((invite) => (
              <li
                key={invite.id}
                className="flex items-center gap-3 px-1.5 py-2.5"
              >
                <span className="relative shrink-0">
                  <UserAvatar name={invite.email} size={34} fontSize={11} />
                  <span
                    aria-hidden="true"
                    className="absolute -bottom-px -right-px size-[11px] rounded-full border-2 border-cream bg-[#d19a2e]"
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13.5px] font-bold text-ink">
                      {invite.email}
                    </span>
                    <span className="shrink-0 rounded px-1.5 py-px font-mono text-[8px] font-bold uppercase tracking-[0.3px] text-[#b07d1e] bg-[#d19a2e]/15">
                      {t("Pending")}
                    </span>
                  </div>
                  <div className="mt-px truncate font-mono text-[9.5px] text-fg-mute">
                    {invite.role === "editor" ? t("Editor") : t("Viewer")}
                    {" · "}
                    {t("invited")}
                  </div>
                </div>
                {isOwner && (
                  <button
                    type="button"
                    onClick={() => handleRevokeInvite(invite.id)}
                    aria-label={t("Revoke invite for {email}", {
                      email: invite.email,
                    })}
                    className="flex h-7 w-[30px] shrink-0 items-center justify-center rounded-[7px] border border-line-strong text-fg-mute transition hover:text-quality-q1"
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {error && <ErrorAlert className="mt-3">{error}</ErrorAlert>}

      {upgradeErr !== null ? (
        <UpgradePrompt
          variant="modal"
          capability={{
            limit: "max_trip_collaborators",
            resolvedLimit: upgradeErr,
          }}
          // An editor's own tier may be unavailable (the cap is the OWNER's, so
          // an editor can invite without a resolved /users/me). The CTA is
          // suppressed for non-owners anyway, so `free` is a harmless fallback
          // that still shows the neutral owner-limit message rather than
          // swallowing the 403 with no feedback.
          currentTier={tier ?? "free"}
          suppressUpgrade={!isOwner}
          message={
            isOwner
              ? t("You've reached the collaborator limit for this trip.")
              : t("The trip owner has reached their collaborator limit.")
          }
          onClose={() => setUpgradeErr(null)}
        />
      ) : null}
    </div>
  );
}
/**
 * Owner-only role dropdown per roster row: Editor / Viewer with the
 * design's capability blurbs, plus the destructive "Remove from trip".
 */
function RoleMenu({
  role,
  label,
  onRoleChange,
  onRemove,
}: {
  role: AssignableTripRole;
  label: string;
  onRoleChange: (role: AssignableTripRole) => void;
  onRemove: () => void;
}) {
  const t = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  // The rows live in the modal body's `overflow-y-auto` scrollport, which
  // clips the menu on whichever side runs out of room — so pick the side
  // (up/down) with more space inside that scroll container when opening.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [openUp, setOpenUp] = useState(false);
  useLayoutEffect(() => {
    if (!menuOpen || !triggerRef.current) return;
    const trigger = triggerRef.current;
    const MENU_HEIGHT = 176; // ~2 options + remove row + padding
    let scroller: HTMLElement | null = trigger.parentElement;
    while (scroller) {
      const oy = getComputedStyle(scroller).overflowY;
      if (oy === "auto" || oy === "scroll") break;
      scroller = scroller.parentElement;
    }
    const rect = trigger.getBoundingClientRect();
    const topBound = scroller?.getBoundingClientRect().top ?? 0;
    const bottomBound =
      scroller?.getBoundingClientRect().bottom ?? window.innerHeight;
    const spaceBelow = bottomBound - rect.bottom;
    const spaceAbove = rect.top - topBound;
    // Prefer opening down; only flip up when below can't fit AND above
    // has more room, so neither edge of the scrollport clips the menu.
    setOpenUp(spaceBelow < MENU_HEIGHT && spaceAbove > spaceBelow);
  }, [menuOpen]);
  return (
    <div className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={t("Change role for {name}", { name: label })}
        onClick={() => setMenuOpen((current) => !current)}
        className="flex items-center gap-1.5 rounded-lg border border-line-strong bg-cream px-2.5 py-1.5 text-xs font-bold text-fg-dim transition hover:text-ink"
      >
        {role === "editor" ? t("Editor") : t("Viewer")}
        <ChevronDown size={13} className="text-fg-mute" />
      </button>
      {menuOpen && (
        <>
          <button
            type="button"
            aria-label={t("Close menu")}
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setMenuOpen(false)}
          />
          <div
            role="menu"
            className={
              "absolute right-0 z-20 w-56 overflow-hidden rounded-[10px] border border-line-strong bg-cream " +
              (openUp
                ? "bottom-full mb-1.5 shadow-[0_-12px_32px_rgba(20,17,14,0.18)]"
                : "top-full mt-1.5 shadow-[0_12px_32px_rgba(20,17,14,0.18)]")
            }
          >
            {[
              {
                value: "editor" as const,
                label: t("Editor"),
                hint: t("Edits the route & moderates suggestions"),
              },
              {
                value: "viewer" as const,
                label: t("Viewer"),
                hint: t("Views, comments, suggests & votes"),
              },
            ].map((option) => (
              <button
                key={option.value}
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  if (option.value !== role) onRoleChange(option.value);
                }}
                className={
                  "block w-full px-3.5 py-2.5 text-left transition hover:bg-paper " +
                  (option.value === role ? "bg-paper" : "")
                }
              >
                <span
                  className={
                    "block text-[12.5px] font-bold " +
                    (option.value === role ? "text-accent" : "text-ink")
                  }
                >
                  {option.label}
                </span>
                <span className="block text-[11px] text-fg-dim">
                  {option.hint}
                </span>
              </button>
            ))}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                onRemove();
              }}
              className="block w-full border-t border-line px-3.5 py-2.5 text-left text-[12.5px] font-bold text-quality-q1 transition hover:bg-quality-q1/10"
            >
              {t("Remove from trip")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
function SuggestionsTab({
  trip,
  serverTripId,
  currentUserId,
  isOwner,
  callerRole,
  hideProposeIntro = false,
  externalSuggestions,
  onExternalChange,
  externalError,
  onPromoted,
}: {
  trip: Trip | null;
  serverTripId: string | null;
  currentUserId: string | null;
  isOwner: boolean;
  callerRole: TripMemberRole | null;
  hideProposeIntro?: boolean;
  externalSuggestions?: TripSuggestion[] | undefined;
  onExternalChange?:
    React.Dispatch<React.SetStateAction<TripSuggestion[]>> | undefined;
  externalError?: string | null | undefined;
  onPromoted?: ((id: string) => void) | undefined;
}) {
  const t = useTranslation();
  const format = useFormat();
  const [localSuggestions, setLocalSuggestions] = useState<TripSuggestion[]>(
    [],
  );
  const usingExternal =
    externalSuggestions !== undefined && onExternalChange !== undefined;
  const suggestions = usingExternal ? externalSuggestions : localSuggestions;
  const setSuggestions = usingExternal ? onExternalChange : setLocalSuggestions;
  // Merge the hook-level fetch error (when using shared state) with any
  // per-action error we produce locally. Render the load error first —
  // it's the more important signal when the list is empty.
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  // Render-side paging only — the full list stays in state so the map
  // overlay and live-update merges keep working on every row. Resets
  // per tab visit (the tab unmounts when switched away from). Open and
  // resolved page independently; resolved additionally starts collapsed
  // so the tab leads with what still needs a decision.
  const [visibleOpenCount, setVisibleOpenCount] = useState(
    SUGGESTIONS_PAGE_SIZE,
  );
  const [visibleResolvedCount, setVisibleResolvedCount] = useState(
    SUGGESTIONS_PAGE_SIZE,
  );
  const [resolvedExpanded, setResolvedExpanded] = useState(false);
  useEffect(() => {
    if (!serverTripId || usingExternal) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const { data } = await tripCollabApi.listSuggestions(serverTripId);
        if (cancelled) return;
        setLocalSuggestions(data);
      } catch (err) {
        if (!cancelled) setError(describeError(err, t));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t, serverTripId, usingExternal]);
  if (!serverTripId) {
    return (
      <PromoteTripCTA
        trip={trip}
        onPromoted={onPromoted}
        headline={t("Collaborative suggestions need a saved trip")}
        body={t(
          "Save this trip to the server to invite riders in your group to suggest alternative segments and vote on them.",
        )}
      />
    );
  }
  const handleCreate = async () => {
    if (!title.trim()) {
      setError(t("Give your suggestion a short title."));
      return;
    }
    // A text suggestion carries no map location — it lives in the modal list
    // only. We deliberately DON'T auto-anchor it to the start waypoint (which
    // dropped a confusing violet dot at the start of every trip); a suggestion
    // only gets a map marker once it's actually placed on the map.
    setCreating(true);
    setError(null);
    try {
      const trimmedDescription = description.trim();
      const { data } = await tripCollabApi.createSuggestion(serverTripId, {
        title: title.trim(),
        ...(trimmedDescription ? { description: trimmedDescription } : {}),
      });
      // Dedupe by id — if the broadcast landed first, replace in place.
      setSuggestions((prev) => {
        const exists = prev.some((x) => x.id === data.id);
        if (exists) return prev.map((x) => (x.id === data.id ? data : x));
        return [data, ...prev];
      });
      setTitle("");
      setDescription("");
    } catch (err) {
      setError(describeError(err, t));
    } finally {
      setCreating(false);
    }
  };
  const handleVote = async (id: string, vote: "up" | "down") => {
    try {
      const { data } = await tripCollabApi.voteSuggestion(
        serverTripId,
        id,
        vote,
      );
      setSuggestions((prev) => prev.map((s) => (s.id === id ? data : s)));
    } catch (err) {
      setError(describeError(err, t));
    }
  };
  const handleUnvote = async (id: string) => {
    try {
      const { data } = await tripCollabApi.unvoteSuggestion(serverTripId, id);
      setSuggestions((prev) => prev.map((s) => (s.id === id ? data : s)));
    } catch (err) {
      setError(describeError(err, t));
    }
  };
  const handleResolve = async (id: string, action: "accept" | "reject") => {
    try {
      const { data } =
        action === "accept"
          ? await tripCollabApi.acceptSuggestion(serverTripId, id)
          : await tripCollabApi.rejectSuggestion(serverTripId, id);
      setSuggestions((prev) => prev.map((s) => (s.id === id ? data : s)));
    } catch (err) {
      setError(describeError(err, t));
    }
  };
  const handleReopen = async (id: string) => {
    try {
      const { data } = await tripCollabApi.reopenSuggestion(serverTripId, id);
      setSuggestions((prev) => prev.map((s) => (s.id === id ? data : s)));
    } catch (err) {
      setError(describeError(err, t));
    }
  };
  const handleDelete = async (id: string) => {
    try {
      await tripCollabApi.deleteSuggestion(serverTripId, id);
      setSuggestions((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      setError(describeError(err, t));
    }
  };
  // Every member may propose and vote (backend opened this to viewers);
  // only owners and editors moderate (accept/reject/reopen).
  const canModerate = isOwner || callerRole === "editor";
  // Open proposals lead (they need votes / a decision); resolved ones
  // collapse behind a summary row so history doesn't bury the queue.
  const openSuggestions = suggestions.filter((s) => s.status === "open");
  const resolvedSuggestions = suggestions.filter((s) => s.status !== "open");
  const acceptedCount = resolvedSuggestions.filter(
    (s) => s.status === "accepted",
  ).length;
  const renderCard = (s: TripSuggestion) => (
    <SuggestionCard
      key={s.id}
      suggestion={s}
      canModerate={canModerate}
      canDeleteOthers={isOwner}
      canVote
      isAuthor={currentUserId === s.suggested_by}
      onVote={(vote) =>
        s.caller_vote === vote ? handleUnvote(s.id) : handleVote(s.id, vote)
      }
      onResolve={(action) => handleResolve(s.id, action)}
      onReopen={() => handleReopen(s.id)}
      onDelete={() => handleDelete(s.id)}
    />
  );
  return (
    <div className="space-y-4">
      {trip ? (
        // Propose form is gated on a locally-loaded trip because we
        // anchor the new suggestion at the first waypoint so it has a
        // map marker. Callers who opened a shared `?tripId=` URL cold
        // land here with `trip === null` and see the hint below — they
        // can still view + vote on existing suggestions via the list
        // further down.
        <section className="rounded-xl border border-line bg-paper p-3.5">
          {!hideProposeIntro && (
            <>
              <h3 className="flex items-center gap-2 text-[13.5px] font-extrabold text-ink">
                <Star
                  size={15}
                  strokeWidth={0}
                  fill="currentColor"
                  className="shrink-0 text-accent"
                />
                {t("Propose an alternative")}
              </h3>
              <p className="mb-3 mt-1 text-xs leading-snug text-fg-dim">
                {t(
                  "Share a route change idea with your group. Members can vote; the trip owner can accept or reject.",
                )}
              </p>
            </>
          )}
          <Input
            tone="cream"
            placeholder={t("Short title (e.g. 'Scenic loop via Passo Giau')")}
            value={title}
            onChange={setTitle}
            ariaLabel={t("Suggestion title")}
            maxLength={200}
            className="mb-2"
          />
          <Textarea
            tone="cream"
            placeholder={t("Optional context — why this route?")}
            value={description}
            onChange={setDescription}
            ariaLabel={t("Suggestion description")}
            rows={2}
            maxLength={2000}
          />
          <div className="mt-2.5">
            <Button
              variant="accent"
              size="md"
              uppercase
              loading={creating}
              disabled={creating || !title.trim()}
              onClick={handleCreate}
            >
              {t("Submit suggestion")}
            </Button>
          </div>
        </section>
      ) : (
        <HintBox>
          {t(
            "Load the trip into the planner to propose a new suggestion. You can still view and vote on existing suggestions below.",
          )}
        </HintBox>
      )}

      {loading && (
        <p className="text-sm text-fg-mute">{t("Loading suggestions…")}</p>
      )}

      {externalError && (
        // Surface a load failure coming from the hook so a silently-
        // swallowed `listSuggestions` error doesn't get rendered as
        // an ambiguous "No suggestions yet" message.
        <ErrorAlert>{externalError}</ErrorAlert>
      )}

      {suggestions.length === 0 && !loading && !externalError && (
        <HintBox>
          {t("No suggestions yet — be the first to propose a route change.")}
        </HintBox>
      )}

      {openSuggestions.length > 0 && (
        <section>
          <div className="mb-2 flex items-center justify-between">
            <span className="font-mono text-[9.5px] uppercase tracking-[0.6px] text-fg-mute">
              {canModerate ? t("Open · needs a decision") : t("Open")}
            </span>
            <span className="font-mono text-[9.5px] text-fg-mute">
              {format.integer(openSuggestions.length)}
            </span>
          </div>
          <ul className="space-y-2.5">
            {openSuggestions.slice(0, visibleOpenCount).map(renderCard)}
          </ul>
          {openSuggestions.length > visibleOpenCount && (
            <ShowMoreButton
              label={t("Show more · {count} hidden", {
                count: openSuggestions.length - visibleOpenCount,
              })}
              onClick={() =>
                setVisibleOpenCount((count) => count + SUGGESTIONS_PAGE_SIZE)
              }
            />
          )}
        </section>
      )}

      {resolvedSuggestions.length > 0 && (
        <section>
          <button
            type="button"
            aria-expanded={resolvedExpanded}
            onClick={() => setResolvedExpanded((expanded) => !expanded)}
            className="flex w-full items-center gap-2.5 rounded-[10px] border border-line bg-paper px-[13px] py-[11px] text-left transition hover:border-line-strong"
          >
            <span className="flex-1 text-[12.5px] font-bold text-fg-dim">
              {t("{resolved} resolved · {accepted} accepted", {
                resolved: resolvedSuggestions.length,
                accepted: acceptedCount,
              })}
            </span>
            <ChevronDown
              size={13}
              className={
                "shrink-0 text-fg-mute transition-transform " +
                (resolvedExpanded ? "rotate-180" : "")
              }
            />
          </button>
          {resolvedExpanded && (
            <>
              <ul className="mt-2.5 space-y-2.5">
                {resolvedSuggestions
                  .slice(0, visibleResolvedCount)
                  .map(renderCard)}
              </ul>
              {resolvedSuggestions.length > visibleResolvedCount && (
                <ShowMoreButton
                  label={t("Show more · {count} hidden", {
                    count: resolvedSuggestions.length - visibleResolvedCount,
                  })}
                  onClick={() =>
                    setVisibleResolvedCount(
                      (count) => count + SUGGESTIONS_PAGE_SIZE,
                    )
                  }
                />
              )}
            </>
          )}
        </section>
      )}

      {error && <ErrorAlert>{error}</ErrorAlert>}
    </div>
  );
}
function SuggestionCard({
  suggestion,
  canModerate,
  canDeleteOthers,
  canVote,
  isAuthor,
  onVote,
  onResolve,
  onReopen,
  onDelete,
}: {
  suggestion: TripSuggestion;
  canModerate: boolean;
  canDeleteOthers: boolean;
  canVote: boolean;
  isAuthor: boolean;
  onVote: (vote: "up" | "down") => void;
  onResolve: (action: "accept" | "reject") => void;
  onReopen: () => void;
  onDelete: () => void;
}) {
  const t = useTranslation();
  const isOpen = suggestion.status === "open";
  return (
    <li
      className={
        "rounded-xl border border-line bg-cream p-3.5" +
        // Rejected proposals fade back; accepted ones stay full-strength
        // (they're part of the plan now) — per the v2 design.
        (suggestion.status === "rejected" ? " opacity-[0.72]" : "")
      }
    >
      <div className="flex items-start justify-between gap-2.5">
        <div className="min-w-0">
          <h4 className="truncate text-sm font-extrabold text-ink">
            {suggestion.title}
          </h4>
          <p className="mt-1 flex items-center gap-1.5 text-[11.5px] text-fg-dim">
            <UserAvatar
              name={suggestion.suggester_display_name}
              size={18}
              fontSize={8}
            />
            {t("by {name}", { name: suggestion.suggester_display_name })}
          </p>
        </div>
        <span
          className={
            "shrink-0 font-mono text-[9px] font-bold uppercase tracking-[0.5px] " +
            (suggestion.status === "accepted"
              ? "text-[#1f8a5b]"
              : suggestion.status === "rejected"
                ? "text-quality-q1"
                : "text-fg-mute")
          }
        >
          {translateKnownLabel(suggestion.status, SUGGESTION_STATUS_LABELS, t)}
        </span>
      </div>
      {suggestion.description && (
        <p className="mt-2.5 whitespace-pre-wrap text-[12.5px] leading-normal text-fg-dim">
          {suggestion.description}
        </p>
      )}
      <div className="mt-3 flex items-center justify-between gap-2.5">
        <div className="flex gap-[7px]">
          <VoteButton
            active={suggestion.caller_vote === "up"}
            disabled={!isOpen || !canVote}
            count={suggestion.up_votes}
            icon={<ThumbsUp size={13} />}
            ariaLabel={t("Vote up")}
            onClick={() => onVote("up")}
          />
          <VoteButton
            active={suggestion.caller_vote === "down"}
            disabled={!isOpen || !canVote}
            count={suggestion.down_votes}
            icon={<ThumbsDown size={13} />}
            ariaLabel={t("Vote down")}
            onClick={() => onVote("down")}
          />
        </div>
        <div className="flex items-center gap-[7px]">
          {canModerate && isOpen && (
            <>
              <Button
                variant="success"
                size="sm"
                onClick={() => onResolve("accept")}
              >
                {t("Accept")}
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => onResolve("reject")}
              >
                {t("Reject")}
              </Button>
            </>
          )}
          {canModerate && !isOpen && (
            <Button variant="secondary" size="sm" onClick={onReopen}>
              {t("Reopen")}
            </Button>
          )}
          {(isAuthor || canDeleteOthers) && (
            <button
              type="button"
              onClick={onDelete}
              aria-label={t("Delete suggestion")}
              className="flex h-7 w-[30px] items-center justify-center rounded-[7px] border border-line-strong text-fg-mute transition hover:text-ink"
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>
      </div>
    </li>
  );
}
function VoteButton({
  active,
  disabled,
  count,
  icon,
  ariaLabel,
  onClick,
}: {
  active: boolean;
  disabled: boolean;
  count: number;
  icon: React.ReactNode;
  ariaLabel: string;
  onClick: () => void;
}) {
  const format = useFormat();
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={active}
      aria-label={ariaLabel}
      className={
        // No opacity fade when disabled — on resolved cards the tallies
        // stay full-strength as a record of the vote (per design); only
        // the cursor signals they're frozen.
        "inline-flex items-center gap-1.5 rounded-lg border px-[11px] py-1.5 font-mono text-xs font-bold transition disabled:cursor-not-allowed " +
        (active
          ? "border-accent bg-accent/10 text-accent"
          : "border-line-strong bg-transparent text-fg-dim hover:text-ink")
      }
    >
      {icon}
      {format.integer(count)}
    </button>
  );
}
function ActivityTab({
  trip,
  serverTripId,
  onPromoted,
}: {
  trip: Trip | null;
  serverTripId: string | null;
  onPromoted?: ((id: string) => void) | undefined;
}) {
  const t = useTranslation();
  const format = useFormat();
  const [entries, setEntries] = useState<TripActivityEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(ACTIVITY_PAGE_SIZE);
  useEffect(() => {
    if (!serverTripId) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const { data } = await tripCollabApi.listActivity(serverTripId);
        if (cancelled) return;
        // Merge instead of replace: a `trip:activity` event that
        // landed before this fetch resolved has already been
        // prepended, and a naive `setEntries(data.activity)` would
        // silently drop it until the user refreshed. Dedupe by id so
        // an entry that appears in both sources (fetch + socket replay)
        // doesn't show twice; newest (live) entries stay on top.
        setEntries((prev) => {
          const restIds = new Set(data.activity.map((e) => e.id));
          const liveOnly = prev.filter((e) => !restIds.has(e.id));
          return [...liveOnly, ...data.activity];
        });
      } catch (err) {
        if (!cancelled) setError(describeError(err, t));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t, serverTripId]);
  useEffect(() => {
    if (!serverTripId) return;
    const off = onTripActivity((payload) => {
      const entry = payload as TripActivityEntry;
      // Filter by trip_id — socket listeners are module-level and
      // survive across trip switches. Without this guard a rogue
      // event from another subscribed trip (e.g. during a brief
      // trip-switch overlap) would be prepended to the visible feed
      // and mix unrelated audit entries.
      if (entry.trip_id !== serverTripId) return;
      setEntries((prev) => {
        // Dedupe by id — Redis-adapter replays can deliver the same
        // entry twice across reconnections. The feed is
        // reverse-chronological (newest first, matching REST
        // `ORDER BY created_at DESC`). This is intended UX.
        if (prev.some((e) => e.id === entry.id)) return prev;
        return [entry, ...prev];
      });
    });
    return off;
  }, [serverTripId]);
  if (!serverTripId) {
    return (
      <PromoteTripCTA
        trip={trip}
        onPromoted={onPromoted}
        headline={t("Activity log needs a saved trip")}
        body={t(
          "Save this trip to the server to record who joined, voted, and resolved suggestions.",
        )}
      />
    );
  }
  if (loading) return <p className="text-sm text-fg-mute">{t("Loading…")}</p>;
  // Render the API error BEFORE the empty-state check so a failed fetch
  // surfaces as an actionable alert rather than a misleading "No
  // activity yet" message when auth/network/server issues prevent the
  // list from loading at all.
  if (error) {
    return <ErrorAlert>{error}</ErrorAlert>;
  }
  if (entries.length === 0) {
    return (
      <HintBox>
        {t(
          "No activity yet. Member joins, suggestion proposals, votes, and resolutions will show up here.",
        )}
      </HintBox>
    );
  }
  return (
    <>
      {groupActivityByDay(entries.slice(0, visibleCount)).map(
        ({ bucket, rows }) => (
          <section key={bucket} className="mt-3.5 first:mt-0">
            <div className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.8px] text-fg-mute">
              {t(DAY_BUCKET_LABELS[bucket])}
            </div>
            <ol>
              {rows.map((entry) => {
                const actor = entry.actor_name ?? t("System");
                return (
                  <li
                    key={entry.id}
                    className="flex items-center gap-3 border-b border-line px-1 py-[11px] last:border-b-0"
                  >
                    <UserAvatar name={actor} size={30} fontSize={10} />
                    <div className="min-w-0 flex-1 text-[13px] text-ink">
                      <b className="font-bold">{actor}</b>{" "}
                      {describeActivityAction(entry, t)}
                    </div>
                    <time
                      dateTime={entry.created_at}
                      className="shrink-0 font-mono text-[9.5px] text-fg-mute"
                    >
                      {/* Bucket-aware: the section header already names the
                          day, so Yesterday rows show the clock time (locale
                          hour cycle) — relativeTime alone would render every
                          yesterday entry as the same "yesterday", losing
                          intra-day ordering. Earlier rows show the date. */}
                      {bucket === "today"
                        ? formatRelativeTimeLabel(
                            entry.created_at,
                            { format },
                            t,
                          )
                        : bucket === "yesterday"
                          ? format.time(entry.created_at)
                          : format.shortDate(entry.created_at)}
                    </time>
                  </li>
                );
              })}
            </ol>
          </section>
        ),
      )}
      {entries.length > visibleCount && (
        <ShowMoreButton
          label={t("Show earlier activity · {count} more", {
            count: entries.length - visibleCount,
          })}
          onClick={() => setVisibleCount((count) => count + ACTIVITY_PAGE_SIZE)}
        />
      )}
    </>
  );
}
function PromoteTripCTA({
  trip,
  headline,
  body,
  onPromoted,
}: {
  trip: Trip | null;
  headline: string;
  body: string;
  onPromoted?: ((id: string) => void) | undefined;
}) {
  const t = useTranslation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!trip) {
    return (
      <HintBox>
        {t("Generate or load a trip first to enable collaboration.")}
      </HintBox>
    );
  }
  const handleSave = async () => {
    setLoading(true);
    setError(null);
    try {
      const { tripsApi } = await import("@/lib/api");
      const { data } = await tripsApi.create({
        title: trip.name || t("Untitled trip"),
        num_days: trip.days.length || 1,
      });
      const serverId = (
        data as {
          id?: string;
        }
      ).id;
      if (serverId && onPromoted) onPromoted(serverId);
    } catch (err) {
      setError(describeError(err, t));
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="rounded-xl border border-line bg-paper p-3.5">
      <h3 className="text-[13.5px] font-extrabold text-ink">{headline}</h3>
      <p className="mt-1 text-xs leading-snug text-fg-dim">{body}</p>
      <div className="mt-3">
        <Button
          variant="accent"
          size="md"
          uppercase
          loading={loading}
          disabled={loading}
          onClick={handleSave}
        >
          {t("Save trip and enable collaboration")}
        </Button>
      </div>
      {error && <ErrorAlert className="mt-3">{error}</ErrorAlert>}
    </div>
  );
}
/**
 * Reveal-next-page button shared by the suggestions and activity lists.
 * Callers put the remaining count in the label — the cut-off must stay
 * honest, or a capped list is indistinguishable from a complete one.
 */
function ShowMoreButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <div className="mt-2.5">
      <Button variant="secondary" size="sm" block onClick={onClick}>
        {label}
      </Button>
    </div>
  );
}
/** Muted informational box shared by the tabs' empty/hint states. */
function HintBox({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-[10px] border border-line bg-paper px-3.5 py-2.5 text-[12.5px] leading-normal text-fg-dim">
      {children}
    </p>
  );
}
/** Inline error alert in the v2 quality-ramp palette. */
function ErrorAlert({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p
      role="alert"
      className={
        "rounded-[10px] border border-quality-q1/40 bg-quality-q1/10 px-3.5 py-2.5 text-[12.5px] leading-normal text-quality-q1 " +
        className
      }
    >
      {children}
    </p>
  );
}
/**
 * Action clause WITHOUT the actor — the timeline row renders the actor
 * name separately (bold, per the v2 design) in front of this text.
 */
function describeActivityAction(
  entry: TripActivityEntry,
  t: Translate,
): string {
  switch (entry.action) {
    case "member_joined":
      return t("joined the trip");
    case "member_left":
      return t("left the trip");
    case "member_invited":
      return entry.payload.already_member
        ? t("invited a rider who is already a member")
        : t("invited a rider by email");
    case "trip_updated":
      return t("updated trip details");
    case "trip_generated":
      return entry.payload.option === "scenic"
        ? t("generated the Scenic sweep itinerary")
        : entry.payload.option === "fastest"
          ? t("generated the Fastest line itinerary")
          : t("generated the Best fit itinerary");
    case "suggestion_created":
      return entry.payload.title
        ? t('proposed "{title}"', { title: String(entry.payload.title) })
        : t("proposed a suggestion");
    case "suggestion_deleted":
      return entry.payload.title
        ? t('removed "{title}"', { title: String(entry.payload.title) })
        : t("removed a suggestion");
    case "suggestion_voted":
      // Older rows predate the title in the vote payload — fall back to
      // the bare direction for those.
      return entry.payload.title
        ? t('voted on "{title}"', { title: String(entry.payload.title) })
        : entry.payload.vote === "up"
          ? t("voted up")
          : t("voted down");
    case "suggestion_vote_removed":
      return entry.payload.title
        ? t('removed their vote on "{title}"', {
            title: String(entry.payload.title),
          })
        : t("removed their vote");
    case "suggestion_accepted":
      return entry.payload.title
        ? t('accepted "{title}"', { title: String(entry.payload.title) })
        : t("accepted a suggestion");
    case "suggestion_rejected":
      return entry.payload.title
        ? t('rejected "{title}"', { title: String(entry.payload.title) })
        : t("rejected a suggestion");
    case "suggestion_reopened":
      return entry.payload.title
        ? t('reopened "{title}"', { title: String(entry.payload.title) })
        : t("reopened a suggestion");
    case "member_removed":
      return t("removed a rider from the trip");
    case "member_role_changed":
      return entry.payload.role === "editor"
        ? t("changed a rider's role to editor")
        : t("changed a rider's role to viewer");
    default:
      // Backend releases can introduce an action before this catalog ships.
      // Never expose that wire token as English-looking rider copy.
      return t("performed an activity that this app version cannot describe");
  }
}
type DayBucket = "today" | "yesterday" | "earlier";
const DAY_BUCKET_LABELS: Record<DayBucket, EnglishMessageKey> = {
  today: "Today",
  yesterday: "Yesterday",
  earlier: "Earlier",
};
function dayBucket(iso: string): DayBucket {
  const startOfDay = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round(
    (startOfDay(new Date()) - startOfDay(new Date(iso))) / 86_400_000,
  );
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return "earlier";
}
/**
 * Split a reverse-chronological entry list into contiguous day-bucket
 * groups (Today / Yesterday / Earlier) for the section headers.
 */
function groupActivityByDay(
  entries: TripActivityEntry[],
): Array<{ bucket: DayBucket; rows: TripActivityEntry[] }> {
  const groups: Array<{ bucket: DayBucket; rows: TripActivityEntry[] }> = [];
  for (const entry of entries) {
    const bucket = dayBucket(entry.created_at);
    const last = groups[groups.length - 1];
    if (last && last.bucket === bucket) last.rows.push(entry);
    else groups.push({ bucket, rows: [entry] });
  }
  return groups;
}
function describeError(err: unknown, t: Translate): string {
  if (err instanceof ApiError)
    return getUserFacingErrorMessage(
      err,
      t("Failed ({statusCode})", { statusCode: err.status }),
    );
  return t("Unknown error");
}
function buildInviteUrl(token: string): string {
  if (typeof window === "undefined") return `/trips/shared/${token}`;
  return `${window.location.origin}/trips/shared/${token}`;
}
