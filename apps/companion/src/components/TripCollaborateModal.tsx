"use client";
import { t } from "@/i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  Copy,
  Link as LinkIcon,
  Loader2,
  MessageSquarePlus,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  X,
} from "lucide-react";
import {
  ApiError,
  tripCollabApi,
  tripSharesApi,
  type TripActivityEntry,
  type TripShareResponse,
  type TripSuggestion,
} from "@/lib/api";
import { onTripActivity } from "@/lib/socket";
import type { Trip } from "@/lib/types";
import { Input, Textarea } from "@tarmoto/ui";
type Tab = "invite" | "suggestions" | "activity";
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
  onClose: () => void;
}
/**
 * US-35 — full collaboration surface for trip planning. Sits on top of
 * the suggestions/voting REST surface from `#250` and adds cursor
 * broadcast + activity log + accept/reject from `#251`.
 *
 * Tabs:
 *   • Invite       — read-only shareable link (from `#249`).
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
  onClose,
}: TripCollaborateModalProps) {
  const [tab, setTab] = useState<Tab>("invite");
  const [share, setShare] = useState<TripShareResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const sessionRef = useRef(0);
  const onCloseRef = useRef(onClose);
  const canCreateInviteLink =
    explicitCanCreateInviteLink ?? serverTripId === null;
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    sessionRef.current += 1;
    setShare(null);
    setError(null);
    setCopied(false);
    setLoading(false);
    setTab("invite");
  }, [open]);
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
  const handleGenerate = useCallback(async () => {
    if (!trip || !canCreateInviteLink) return;
    const session = sessionRef.current;
    setLoading(true);
    setError(null);
    try {
      const { data } = await tripSharesApi.create({
        title: trip.name || "Untitled trip",
        snapshot: trip as unknown as Record<string, unknown>,
        trip_id: serverTripId,
      });
      if (session !== sessionRef.current) return;
      setShare(data);
    } catch (err) {
      if (session !== sessionRef.current) return;
      setError(describeError(err));
    } finally {
      if (session === sessionRef.current) setLoading(false);
    }
  }, [canCreateInviteLink, serverTripId, trip]);
  const handleCopy = useCallback(async () => {
    if (!share) return;
    const url = buildInviteUrl(share.share_token);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setError("Copy failed — select the URL manually.");
    }
  }, [share]);
  if (!open) return null;
  const inviteUrl = share ? buildInviteUrl(share.share_token) : null;
  const isOwner = Boolean(
    currentUserId && ownerId && currentUserId === ownerId,
  );
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
      <div className="w-full max-w-2xl max-h-[85vh] overflow-hidden rounded-2xl border border-line bg-cream shadow-[0_24px_60px_rgba(14,14,16,0.25)] flex flex-col">
        <div className="flex items-start justify-between gap-4 border-b border-line p-6">
          <div>
            <h2
              id="trip-collaborate-title"
              className="text-lg font-semibold text-ink"
            >
              {t("Collaborate on this trip ")}
            </h2>
            <p className="mt-1 text-sm text-fg-dim">
              {t(
                "Share a group link, gather route suggestions from your riders, and track the activity log. ",
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("Close dialog")}
            className="rounded-lg p-1.5 text-fg-dim hover:bg-paper hover:text-ink transition"
          >
            <X size={16} />
          </button>
        </div>

        <nav
          role="tablist"
          aria-label={t("Collaboration tabs")}
          className="flex border-b border-line bg-paper/60"
        >
          {(
            [
              { id: "invite", label: "Invite link" },
              { id: "suggestions", label: "Suggestions" },
              { id: "activity", label: "Activity" },
            ] as {
              id: Tab;
              label: string;
            }[]
          ).map(({ id, label }) => (
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
                "px-4 py-2.5 text-sm font-medium border-b-2 transition " +
                (tab === id
                  ? "border-accent text-ink"
                  : "border-transparent text-fg-dim hover:text-ink")
              }
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="flex-1 overflow-y-auto p-6">
          {tab === "invite" && (
            <InviteTab
              trip={trip}
              share={share}
              loading={loading}
              copied={copied}
              inviteUrl={inviteUrl}
              canCreateInviteLink={canCreateInviteLink}
              onGenerate={handleGenerate}
              onCopy={handleCopy}
            />
          )}

          {tab === "suggestions" && (
            <SuggestionsTab
              trip={trip}
              serverTripId={serverTripId}
              currentUserId={currentUserId}
              isOwner={isOwner}
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

          {error && (
            <p
              role="alert"
              className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-700"
            >
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
function InviteTab({
  trip,
  share,
  loading,
  copied,
  inviteUrl,
  canCreateInviteLink,
  onGenerate,
  onCopy,
}: {
  trip: Trip | null;
  share: TripShareResponse | null;
  loading: boolean;
  copied: boolean;
  inviteUrl: string | null;
  canCreateInviteLink: boolean;
  onGenerate: () => void;
  onCopy: () => void;
}) {
  if (!trip) {
    return (
      <p className="rounded-lg border border-line bg-paper px-3 py-2 text-sm text-fg-dim">
        {t("Generate or load a trip first to create an invite link. ")}
      </p>
    );
  }
  if (!canCreateInviteLink) {
    return (
      <p className="rounded-lg border border-line bg-paper px-3 py-2 text-sm text-fg-dim">
        {t("Only trip owners and admins can create invite links. ")}
      </p>
    );
  }
  if (!share) {
    return (
      <button
        type="button"
        onClick={onGenerate}
        disabled={loading}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent/10 px-4 py-2.5 text-sm font-medium text-accent hover:bg-accent/20 transition disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? (
          <>
            <Loader2 size={14} className="animate-spin" />
            {t("Generating\u2026 ")}
          </>
        ) : (
          <>
            <LinkIcon size={14} />
            {t("Create invite link ")}
          </>
        )}
      </button>
    );
  }
  return (
    <div className="space-y-3">
      <label className="block text-xs font-medium uppercase tracking-wide text-fg-mute">
        {t("Invite link ")}
      </label>
      <div className="flex items-stretch overflow-hidden rounded-lg border border-line bg-paper">
        <input
          readOnly
          value={inviteUrl ?? ""}
          aria-label={t("Shareable invite URL")}
          className="flex-1 bg-transparent px-3 py-2 text-sm text-ink outline-none"
          onFocus={(event) => event.currentTarget.select()}
        />
        <button
          type="button"
          onClick={onCopy}
          className="flex items-center gap-1.5 border-l border-line px-3 text-sm text-fg-dim hover:bg-paper transition"
        >
          {copied ? (
            <>
              <Check size={14} className="text-accent" />
              {t("Copied ")}
            </>
          ) : (
            <>
              <Copy size={14} />
              {t("Copy ")}
            </>
          )}
        </button>
      </div>
      <p className="text-xs text-fg-mute">
        {t(
          "Anyone with the link can preview the trip. Signed-in riders can join it and open the planner to suggest changes or vote. ",
        )}
      </p>
    </div>
  );
}
function SuggestionsTab({
  trip,
  serverTripId,
  currentUserId,
  isOwner,
  externalSuggestions,
  onExternalChange,
  externalError,
  onPromoted,
}: {
  trip: Trip | null;
  serverTripId: string | null;
  currentUserId: string | null;
  isOwner: boolean;
  externalSuggestions?: TripSuggestion[];
  onExternalChange?: React.Dispatch<React.SetStateAction<TripSuggestion[]>>;
  externalError?: string | null;
  onPromoted?: (id: string) => void;
}) {
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
        if (!cancelled) setError(describeError(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverTripId, usingExternal]);
  if (!serverTripId) {
    return (
      <PromoteTripCTA
        trip={trip}
        onPromoted={onPromoted}
        headline="Collaborative suggestions need a saved trip"
        body="Save this trip to the server to invite riders in your group to suggest alternative segments and vote on them."
      />
    );
  }
  const handleCreate = async () => {
    if (!title.trim()) {
      setError("Give your suggestion a short title.");
      return;
    }
    // Anchor the suggestion on the map at the first waypoint of the
    // active trip so it's visible in the overlay. Without lat/lng the
    // `buildSuggestionCollection` builder would drop the row from the
    // map layer — a coordless suggestion still appears in the modal
    // list but is invisible on the map for everyone. Callers without
    // a loaded trip land here with `trip === null` (form is hidden),
    // so this branch only runs with a real route to anchor to.
    const anchor = pickSuggestionAnchor(trip);
    setCreating(true);
    setError(null);
    try {
      const { data } = await tripCollabApi.createSuggestion(serverTripId, {
        title: title.trim(),
        description: description.trim() || undefined,
        lat: anchor?.lat,
        lng: anchor?.lng,
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
      setError(describeError(err));
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
      setError(describeError(err));
    }
  };
  const handleUnvote = async (id: string) => {
    try {
      const { data } = await tripCollabApi.unvoteSuggestion(serverTripId, id);
      setSuggestions((prev) => prev.map((s) => (s.id === id ? data : s)));
    } catch (err) {
      setError(describeError(err));
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
      setError(describeError(err));
    }
  };
  const handleDelete = async (id: string) => {
    try {
      await tripCollabApi.deleteSuggestion(serverTripId, id);
      setSuggestions((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <div className="space-y-5">
      {trip ? (
        // Propose form is gated on a locally-loaded trip because we
        // anchor the new suggestion at the first waypoint so it has a
        // map marker. Callers who opened a shared `?tripId=` URL cold
        // land here with `trip === null` and see the hint below — they
        // can still view + vote on existing suggestions via the list
        // further down.
        <section className="space-y-2 rounded-lg border border-line bg-paper p-4">
          <h3 className="text-sm font-semibold text-ink flex items-center gap-2">
            <MessageSquarePlus size={14} className="text-accent" />
            {t("Propose an alternative ")}
          </h3>
          <p className="text-xs text-fg-dim">
            {t(
              "Share a route change idea with your group. Members can vote; the trip owner can accept or reject. ",
            )}
          </p>
          <Input
            tone="cream"
            placeholder={t("Short title (e.g. 'Scenic loop via Passo Giau')")}
            value={title}
            onChange={setTitle}
            ariaLabel={t("Suggestion title")}
            maxLength={200}
          />
          <Textarea
            tone="cream"
            placeholder={t("Optional context \u2014 why this route?")}
            value={description}
            onChange={setDescription}
            ariaLabel={t("Suggestion description")}
            rows={2}
            maxLength={2000}
          />
          <button
            type="button"
            onClick={handleCreate}
            disabled={creating || !title.trim()}
            className="flex items-center gap-2 rounded-md bg-accent/10 px-3 py-1.5 text-sm font-medium text-accent hover:bg-accent/20 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {creating ? (
              <>
                <Loader2 size={12} className="animate-spin" />
                {t("Submitting\u2026 ")}
              </>
            ) : (
              "Submit suggestion"
            )}
          </button>
        </section>
      ) : (
        <p className="rounded-lg border border-line bg-paper px-3 py-2 text-sm text-fg-dim">
          {t(
            "Load the trip into the planner to propose a new suggestion. You can still view and vote on existing suggestions below. ",
          )}
        </p>
      )}

      {loading && (
        <p className="text-sm text-fg-mute">{t("Loading suggestions\u2026")}</p>
      )}

      {externalError && (
        // Surface a load failure coming from the hook so a silently-
        // swallowed `listSuggestions` error doesn't get rendered as
        // an ambiguous "No suggestions yet" message.
        <p
          role="alert"
          className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-700"
        >
          {externalError}
        </p>
      )}

      {suggestions.length === 0 && !loading && !externalError && (
        <p className="rounded-lg border border-line bg-paper px-3 py-2 text-sm text-fg-dim">
          {t(
            "No suggestions yet \u2014 be the first to propose a route change. ",
          )}
        </p>
      )}

      <ul className="space-y-3">
        {suggestions.map((s) => (
          <SuggestionCard
            key={s.id}
            suggestion={s}
            isOwner={isOwner}
            isAuthor={currentUserId === s.suggested_by}
            onVote={(vote) =>
              s.caller_vote === vote
                ? handleUnvote(s.id)
                : handleVote(s.id, vote)
            }
            onResolve={(action) => handleResolve(s.id, action)}
            onDelete={() => handleDelete(s.id)}
          />
        ))}
      </ul>

      {error && (
        <p
          role="alert"
          className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </p>
      )}
    </div>
  );
}
function SuggestionCard({
  suggestion,
  isOwner,
  isAuthor,
  onVote,
  onResolve,
  onDelete,
}: {
  suggestion: TripSuggestion;
  isOwner: boolean;
  isAuthor: boolean;
  onVote: (vote: "up" | "down") => void;
  onResolve: (action: "accept" | "reject") => void;
  onDelete: () => void;
}) {
  const isOpen = suggestion.status === "open";
  const statusBadge = (
    <span
      className={
        "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide " +
        (suggestion.status === "accepted"
          ? "bg-emerald-500/15 text-emerald-700"
          : suggestion.status === "rejected"
            ? "bg-red-500/15 text-red-700"
            : "bg-paper text-fg-dim")
      }
    >
      {suggestion.status}
    </span>
  );
  return (
    <li className="rounded-lg border border-line bg-paper p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-ink truncate">
            {suggestion.title}
          </h4>
          <p className="text-xs text-fg-mute">
            {t("by ")}
            {suggestion.suggester_display_name}
          </p>
        </div>
        {statusBadge}
      </div>
      {suggestion.description && (
        <p className="mt-2 text-sm text-fg-dim whitespace-pre-wrap">
          {suggestion.description}
        </p>
      )}
      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!isOpen}
            onClick={() => onVote("up")}
            aria-pressed={suggestion.caller_vote === "up"}
            aria-label={t("Vote up")}
            className={
              "flex items-center gap-1 rounded-md px-2 py-1 text-xs border transition disabled:opacity-50 disabled:cursor-not-allowed " +
              (suggestion.caller_vote === "up"
                ? "border-accent/50 bg-accent/10 text-accent"
                : "border-line bg-cream text-fg-dim hover:border-line-strong")
            }
          >
            <ThumbsUp size={12} /> {suggestion.up_votes}
          </button>
          <button
            type="button"
            disabled={!isOpen}
            onClick={() => onVote("down")}
            aria-pressed={suggestion.caller_vote === "down"}
            aria-label={t("Vote down")}
            className={
              "flex items-center gap-1 rounded-md px-2 py-1 text-xs border transition disabled:opacity-50 disabled:cursor-not-allowed " +
              (suggestion.caller_vote === "down"
                ? "border-red-500/50 bg-red-500/10 text-red-700"
                : "border-line bg-cream text-fg-dim hover:border-line-strong")
            }
          >
            <ThumbsDown size={12} /> {suggestion.down_votes}
          </button>
        </div>
        <div className="flex items-center gap-2">
          {isOwner && isOpen && (
            <>
              <button
                type="button"
                onClick={() => onResolve("accept")}
                className="rounded-md bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-500/15"
              >
                {t("Accept ")}
              </button>
              <button
                type="button"
                onClick={() => onResolve("reject")}
                className="rounded-md bg-red-500/10 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-500/15"
              >
                {t("Reject ")}
              </button>
            </>
          )}
          {(isAuthor || isOwner) && (
            <button
              type="button"
              onClick={onDelete}
              aria-label={t("Delete suggestion")}
              className="rounded-md bg-paper px-2 py-1 text-xs text-fg-dim hover:bg-paper hover:text-ink"
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
      </div>
    </li>
  );
}
function ActivityTab({
  trip,
  serverTripId,
  onPromoted,
}: {
  trip: Trip | null;
  serverTripId: string | null;
  onPromoted?: (id: string) => void;
}) {
  const [entries, setEntries] = useState<TripActivityEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
        if (!cancelled) setError(describeError(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverTripId]);
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
        headline="Activity log needs a saved trip"
        body="Save this trip to the server to record who joined, voted, and resolved suggestions."
      />
    );
  }
  if (loading)
    return <p className="text-sm text-fg-mute">{t("Loading\u2026")}</p>;
  // Render the API error BEFORE the empty-state check so a failed fetch
  // surfaces as an actionable alert rather than a misleading "No
  // activity yet" message when auth/network/server issues prevent the
  // list from loading at all.
  if (error) {
    return (
      <p
        role="alert"
        className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-700"
      >
        {error}
      </p>
    );
  }
  if (entries.length === 0) {
    return (
      <p className="rounded-lg border border-line bg-paper px-3 py-2 text-sm text-fg-dim">
        {t(
          "No activity yet. Member joins, suggestion proposals, votes, and resolutions will show up here. ",
        )}
      </p>
    );
  }
  return (
    <>
      <ol className="space-y-2">
        {entries.map((entry) => (
          <li
            key={entry.id}
            className="rounded-md border border-line bg-paper px-3 py-2 text-sm text-ink"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium">
                {entry.actor_name ?? "System"}
              </span>
              <time
                dateTime={entry.created_at}
                className="text-xs text-fg-mute"
              >
                {formatRelativeTime(entry.created_at)}
              </time>
            </div>
            <p className="mt-0.5 text-xs text-fg-dim">
              {describeActivity(entry)}
            </p>
          </li>
        ))}
      </ol>
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
  onPromoted?: (id: string) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!trip) {
    return (
      <p className="rounded-lg border border-line bg-paper px-3 py-2 text-sm text-fg-dim">
        {t("Generate or load a trip first to enable collaboration. ")}
      </p>
    );
  }
  const handleSave = async () => {
    setLoading(true);
    setError(null);
    try {
      const { tripsApi } = await import("@/lib/api");
      const { data } = await tripsApi.create({
        title: trip.name || "Untitled trip",
        num_days: trip.days.length || 1,
      });
      const serverId = (
        data as {
          id?: string;
        }
      ).id;
      if (serverId && onPromoted) onPromoted(serverId);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="space-y-3 rounded-lg border border-line bg-paper p-4">
      <div>
        <h3 className="text-sm font-semibold text-ink">{headline}</h3>
        <p className="mt-1 text-xs text-fg-dim">{body}</p>
      </div>
      <button
        type="button"
        onClick={handleSave}
        disabled={loading}
        className="flex items-center gap-2 rounded-md bg-accent/10 px-3 py-1.5 text-sm font-medium text-accent hover:bg-accent/20 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? (
          <>
            <Loader2 size={12} className="animate-spin" />
            {t("Saving\u2026 ")}
          </>
        ) : (
          "Save trip and enable collaboration"
        )}
      </button>
      {error && (
        <p
          role="alert"
          className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </p>
      )}
    </div>
  );
}
/**
 * Anchor a new suggestion to the trip's first waypoint so the map
 * overlay has somewhere to render the marker. Returns null for empty
 * trips; callers then fall back to a coordless suggestion (visible in
 * the modal list only).
 */
function pickSuggestionAnchor(trip: Trip | null): {
  lat: number;
  lng: number;
} | null {
  if (!trip) return null;
  for (const day of trip.days) {
    const first = day.waypoints[0];
    if (first) {
      return { lat: first.location.lat, lng: first.location.lng };
    }
  }
  return null;
}
function describeActivity(entry: TripActivityEntry): string {
  const actor = entry.actor_name ?? "Someone";
  switch (entry.action) {
    case "member_joined":
      return `${actor} joined the trip`;
    case "member_left":
      return `${actor} left the trip`;
    case "trip_updated":
      return `${actor} updated trip details`;
    case "trip_generated": {
      const option = entry.payload.option;
      const label =
        option === "scenic"
          ? "Scenic sweep"
          : option === "fastest"
            ? "Fastest line"
            : "Best fit";
      return `${actor} generated a ${label} itinerary`;
    }
    case "suggestion_created":
      return `${actor} proposed "${String(entry.payload.title ?? "a suggestion")}"`;
    case "suggestion_deleted":
      return `${actor} removed "${String(entry.payload.title ?? "a suggestion")}"`;
    case "suggestion_voted":
      return `${actor} voted ${entry.payload.vote === "up" ? "up" : "down"}`;
    case "suggestion_vote_removed":
      return `${actor} removed their vote`;
    case "suggestion_accepted":
      return `${actor} accepted "${String(entry.payload.title ?? "a suggestion")}"`;
    case "suggestion_rejected":
      return `${actor} rejected "${String(entry.payload.title ?? "a suggestion")}"`;
    default:
      // A backend release can introduce a new action before the
      // companion rolls out; fall back to a readable transliteration
      // of the action key instead of letting the timeline render
      // undefined/empty for the row.
      return `${actor} ${String(entry.action).replace(/_/g, " ")}`;
  }
}
function formatRelativeTime(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return d.toLocaleDateString();
}
function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.message ?? `Failed (${err.status})`;
  if (err instanceof Error) return err.message;
  return "Unknown error";
}
function buildInviteUrl(token: string): string {
  if (typeof window === "undefined") return `/trips/shared/${token}`;
  return `${window.location.origin}/trips/shared/${token}`;
}
