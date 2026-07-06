import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, IsNull, Repository } from 'typeorm';
import { pointToLatLng } from '@tarmoto/shared';
import { TripMember } from '../../entities/trip-member.entity.js';
import { TripSuggestion } from '../../entities/trip-suggestion.entity.js';
import { TripSuggestionVote } from '../../entities/trip-suggestion-vote.entity.js';
import { TripMessage } from '../../entities/trip-message.entity.js';
import { TripDay } from '../../entities/trip-day.entity.js';
import { RoadSegment } from '../../entities/road-segment.entity.js';
import { EventsGateway } from '../events/events.gateway.js';
import { TripActivityService } from '../trip-activity/trip-activity.service.js';
import { CreateSuggestionDto } from './dto/create-suggestion.dto.js';
import { SuggestionDto } from './dto/suggestion-response.dto.js';
import { MessageDto } from './dto/message-response.dto.js';
import { CreateMessageDto } from './dto/create-message.dto.js';
import { ListMessagesDto } from './dto/list-messages.dto.js';

const DEFAULT_MESSAGE_PAGE_SIZE = 50;
const MAX_MESSAGE_PAGE_SIZE = 100;

// Roles that may mutate trip metadata or remove any member's
// suggestions/messages. Regular members can only remove their own
// authored rows. Keeping the set tight here so role changes don't need
// to ripple through per-endpoint checks.
const PRIVILEGED_ROLES = new Set(['owner', 'editor']);

/**
 * Orchestrates the collaborative-trip surface: suggestions, votes,
 * chat. Membership is re-checked on every call because a client
 * subscribed to `trip:{id}` may have been removed between the
 * subscription and a subsequent mutation; trusting only the WebSocket
 * room would let ex-members keep editing until they reconnect.
 *
 * Every mutation fans out via `EventsGateway.emitToTrip` so other
 * members subscribed to the trip room see the change without a
 * follow-up REST refetch.
 */
@Injectable()
export class TripCollabService {
  constructor(
    @InjectRepository(TripMember)
    private readonly memberRepo: Repository<TripMember>,
    @InjectRepository(TripSuggestion)
    private readonly suggestionRepo: Repository<TripSuggestion>,
    @InjectRepository(TripSuggestionVote)
    private readonly voteRepo: Repository<TripSuggestionVote>,
    @InjectRepository(TripMessage)
    private readonly messageRepo: Repository<TripMessage>,
    @InjectRepository(TripDay)
    private readonly dayRepo: Repository<TripDay>,
    @InjectRepository(RoadSegment)
    private readonly roadSegmentRepo: Repository<RoadSegment>,
    private readonly events: EventsGateway,
    private readonly activity: TripActivityService,
  ) {}

  // ── Suggestions ──────────────────────────────────────────────────

  async listSuggestions(
    userId: string,
    tripId: string,
  ): Promise<SuggestionDto[]> {
    await this.requireMembership(userId, tripId);

    // Pull the suggestions with suggester info, then aggregate votes in
    // a second query keyed by suggestion_id. Two round-trips is worth it
    // to avoid a GROUP BY that also joins the user relation — TypeORM's
    // aggregation support interacts poorly with `leftJoinAndSelect`.
    const suggestions = await this.suggestionRepo.find({
      where: { trip_id: tripId },
      relations: { suggester: true },
      order: { created_at: 'DESC' },
    });

    if (suggestions.length === 0) return [];

    const ids = suggestions.map((s) => s.id);
    // Use `In(ids)` so TypeORM emits a single `IN (...)` predicate
    // instead of expanding an OR-chain of N equality checks — cleaner
    // plan and one bound-parameter slot regardless of suggestion count.
    const votes = await this.voteRepo.find({
      where: { suggestion_id: In(ids) },
    });

    const tallies = new Map<string, { up: number; down: number }>();
    const callerVote = new Map<string, 'up' | 'down'>();
    for (const v of votes) {
      const agg = tallies.get(v.suggestion_id) ?? { up: 0, down: 0 };
      if (v.vote === 'up') agg.up += 1;
      else agg.down += 1;
      tallies.set(v.suggestion_id, agg);
      if (v.user_id === userId) callerVote.set(v.suggestion_id, v.vote);
    }

    return suggestions.map((s) =>
      toSuggestionDto(
        s,
        tallies.get(s.id) ?? { up: 0, down: 0 },
        callerVote.get(s.id) ?? null,
      ),
    );
  }

  async createSuggestion(
    userId: string,
    tripId: string,
    dto: CreateSuggestionDto,
  ): Promise<SuggestionDto> {
    await this.requireContributor(userId, tripId);

    if (dto.trip_day_id) {
      // A day-scoped suggestion must reference a day that belongs to the
      // same trip — otherwise the "suggestions on day N" UI would leak
      // rows from unrelated trips.
      const day = await this.dayRepo.findOne({
        where: { id: dto.trip_day_id, trip_id: tripId },
      });
      if (!day)
        throw new BadRequestException('trip_day_id is not a day of this trip');
    }

    if (dto.road_segment_id) {
      // Mirror the trip_day_id check: validate the FK exists up front so
      // a typo'd id surfaces as a 400 instead of a 500 from the DB's
      // foreign-key constraint bubbling up as a \`23503\`. Existence-only
      // check — any road segment is globally referenceable.
      // Requires the segment to be LIVE (deactivated_at IS NULL, #835): a
      // tombstoned road that /roads/:id, tiles, and nearby discovery all hide
      // must not be a suggestion target.
      const segment = await this.roadSegmentRepo.findOne({
        where: { id: dto.road_segment_id, deactivated_at: IsNull() },
        select: { id: true },
      });
      if (!segment)
        throw new BadRequestException('road_segment_id does not exist');
    }

    const location =
      dto.lat != null && dto.lng != null
        ? { type: 'Point' as const, coordinates: [dto.lng, dto.lat] }
        : null;

    const entity = this.suggestionRepo.create({
      trip_id: tripId,
      trip_day_id: dto.trip_day_id ?? null,
      suggested_by: userId,
      road_segment_id: dto.road_segment_id ?? null,
      title: dto.title,
      description: dto.description ?? null,
      location,
      status: 'open',
    });
    const saved = await this.suggestionRepo.save(entity);

    // Reload with suggester relation so the response has display_name
    // without us having to hand-stitch the user row.
    const hydrated = await this.suggestionRepo.findOne({
      where: { id: saved.id },
      relations: { suggester: true },
    });
    if (!hydrated) {
      // Would only happen if another request deleted the row between the
      // save and the reload — treat it as a transient error.
      throw new NotFoundException('Suggestion disappeared after create');
    }

    const response = toSuggestionDto(hydrated, { up: 0, down: 0 }, null);
    this.events.emitToTrip(tripId, 'trip:suggestion:created', response);
    await this.activity.recordSafe(tripId, userId, 'suggestion_created', {
      suggestion_id: saved.id,
      title: saved.title,
    });
    return response;
  }

  async deleteSuggestion(
    userId: string,
    tripId: string,
    suggestionId: string,
  ): Promise<void> {
    const membership = await this.requireMembership(userId, tripId);
    const suggestion = await this.suggestionRepo.findOne({
      where: { id: suggestionId, trip_id: tripId },
    });
    if (!suggestion) throw new NotFoundException('Suggestion not found');

    // Authors can always remove their own. Beyond that only privileged
    // roles (owner/admin) can delete others' — keeps a plain member
    // from nuking peer proposals.
    const isAuthor = suggestion.suggested_by === userId;
    const isPrivileged = PRIVILEGED_ROLES.has(membership.role);
    if (!isAuthor && !isPrivileged) {
      throw new ForbiddenException('Cannot delete this suggestion');
    }

    await this.suggestionRepo.delete({ id: suggestionId });
    this.events.emitToTrip(tripId, 'trip:suggestion:deleted', {
      suggestion_id: suggestionId,
    });
    await this.activity.recordSafe(tripId, userId, 'suggestion_deleted', {
      suggestion_id: suggestionId,
      title: suggestion.title,
    });
  }

  /**
   * Resolve a pending suggestion by marking it `accepted` or `rejected`.
   * Owner/admin only — authors of the suggestion can delete their own
   * but cannot unilaterally resolve them. Re-resolving an already
   * resolved row is a 400 so the UI can surface a clear error rather
   * than silently toggling status.
   */
  async resolveSuggestion(
    userId: string,
    tripId: string,
    suggestionId: string,
    status: 'accepted' | 'rejected',
  ): Promise<SuggestionDto> {
    const membership = await this.requireMembership(userId, tripId);
    if (!PRIVILEGED_ROLES.has(membership.role)) {
      throw new ForbiddenException(
        'Only the trip owner or an admin can resolve a suggestion',
      );
    }

    // Atomic transition: UPDATE ... WHERE status = 'open' so two
    // concurrent owner/admin resolves can't both observe 'open' and
    // race to overwrite each other. Whoever flips first wins; the
    // loser sees affected = 0 and returns 400 with the now-current
    // status instead of silently clobbering the decision and fanning
    // out a conflicting `trip:suggestion:resolved` broadcast.
    const result = await this.suggestionRepo.update(
      { id: suggestionId, trip_id: tripId, status: 'open' },
      { status },
    );
    if ((result.affected ?? 0) === 0) {
      // Disambiguate: missing row vs. already resolved.
      const existing = await this.suggestionRepo.findOne({
        where: { id: suggestionId, trip_id: tripId },
        select: { id: true, status: true },
      });
      if (!existing) throw new NotFoundException('Suggestion not found');
      throw new BadRequestException(`Suggestion is already ${existing.status}`);
    }

    // Reload with suggester relation for the response body. Safe to do
    // after the UPDATE — the row is now `accepted`/`rejected` and our
    // status check above was authoritative.
    const suggestion = await this.suggestionRepo.findOne({
      where: { id: suggestionId },
      relations: { suggester: true },
    });
    if (!suggestion) {
      // Would only happen if another request deleted the row between
      // the UPDATE and this read — vanishingly rare, treat as transient.
      throw new NotFoundException('Suggestion not found');
    }

    const action =
      status === 'accepted' ? 'suggestion_accepted' : 'suggestion_rejected';
    await this.activity.recordSafe(tripId, userId, action, {
      suggestion_id: suggestionId,
      title: suggestion.title,
    });

    // Dedicated `trip:suggestion:resolved` broadcast — the vote-tally
    // event doesn't carry `status` and clients need to re-render the
    // accepted/rejected badge without a refetch.
    this.events.emitToTrip(tripId, 'trip:suggestion:resolved', {
      suggestion_id: suggestionId,
      status,
    });
    // Reuse the vote-tally aggregator to build the response body so the
    // shape matches the list endpoint. Pass `false` to skip the
    // (wrong-event-name) vote broadcast the helper would otherwise emit.
    return this.emitAndReturnSuggestion(userId, tripId, suggestion, false);
  }

  /**
   * Flip an accepted/rejected suggestion back to `open` so the group can
   * keep voting and the owner can re-decide. Mirrors `resolveSuggestion`
   * (privileged only, atomic status-guarded UPDATE) with the inverse
   * transition: resolved → open.
   */
  async reopenSuggestion(
    userId: string,
    tripId: string,
    suggestionId: string,
  ): Promise<SuggestionDto> {
    const membership = await this.requireMembership(userId, tripId);
    if (!PRIVILEGED_ROLES.has(membership.role)) {
      throw new ForbiddenException(
        'Only the trip owner or an admin can reopen a suggestion',
      );
    }

    // Atomic transition: only rows currently resolved may flip back, so
    // a double-click (or a reopen racing another owner's reopen) can't
    // fan out duplicate `resolved` broadcasts for an already-open row.
    const result = await this.suggestionRepo.update(
      {
        id: suggestionId,
        trip_id: tripId,
        status: In(['accepted', 'rejected']),
      },
      { status: 'open' },
    );
    if ((result.affected ?? 0) === 0) {
      const existing = await this.suggestionRepo.findOne({
        where: { id: suggestionId, trip_id: tripId },
        select: { id: true, status: true },
      });
      if (!existing) throw new NotFoundException('Suggestion not found');
      throw new BadRequestException('Suggestion is already open');
    }

    const suggestion = await this.suggestionRepo.findOne({
      where: { id: suggestionId },
      relations: { suggester: true },
    });
    if (!suggestion) {
      throw new NotFoundException('Suggestion not found');
    }

    await this.activity.recordSafe(tripId, userId, 'suggestion_reopened', {
      suggestion_id: suggestionId,
      title: suggestion.title,
    });

    // Same event clients already handle for accept/reject — `open`
    // simply re-enables the vote controls and clears the badge.
    this.events.emitToTrip(tripId, 'trip:suggestion:resolved', {
      suggestion_id: suggestionId,
      status: 'open',
    });
    return this.emitAndReturnSuggestion(userId, tripId, suggestion, false);
  }

  async voteSuggestion(
    userId: string,
    tripId: string,
    suggestionId: string,
    vote: 'up' | 'down',
  ): Promise<SuggestionDto> {
    await this.requireContributor(userId, tripId);

    // Serialize against `resolveSuggestion` via a pessimistic_write
    // lock on the suggestion row. A naive read-then-write check would
    // let a vote land between `SELECT status` and `INSERT/UPDATE vote`
    // if the owner resolves mid-flight — the vote row would be written
    // and `trip:suggestion:voted` broadcast on a now-closed suggestion.
    // The lock blocks this handler until any in-flight resolve commits,
    // at which point our status check reflects the final value.
    const { suggestion, hasChange } =
      await this.suggestionRepo.manager.transaction(async (manager) => {
        // No `relations` here: Postgres rejects `FOR UPDATE` on the
        // nullable side of the suggester LEFT JOIN (error 0A000). The
        // suggester is hydrated by the post-tx re-read below; the
        // locked row only feeds the status check and the DTO fallback
        // (which tolerates a missing suggester).
        const locked = await manager.findOne(TripSuggestion, {
          where: { id: suggestionId, trip_id: tripId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!locked) throw new NotFoundException('Suggestion not found');
        if (locked.status !== 'open') {
          throw new BadRequestException(
            `Cannot vote on a ${locked.status} suggestion`,
          );
        }

        // Detect a same-value re-submit up front so a double-tap on
        // the already-selected vote doesn't fan out a stale tally to
        // every subscriber.
        const priorVote = await manager.findOne(TripSuggestionVote, {
          where: { suggestion_id: suggestionId, user_id: userId },
          select: { vote: true },
        });
        const change = priorVote?.vote !== vote;

        await this.upsertVoteIn(manager, suggestionId, userId, vote);

        return { suggestion: locked, hasChange: change };
      });

    if (hasChange) {
      await this.activity.recordSafe(tripId, userId, 'suggestion_voted', {
        suggestion_id: suggestionId,
        vote,
        // Title lets the timeline say `voted on "…"` without a join.
        title: suggestion.title,
      });
    }

    // Re-read after the tx so a resolve that committed in the gap
    // between our lock release and the HTTP response reflects in the
    // DTO. Without this the voter's UI would keep rendering
    // `status: 'open'` until the `trip:suggestion:resolved` broadcast
    // arrives, briefly re-enabling vote controls on a finalised row.
    const fresh = await this.suggestionRepo.findOne({
      where: { id: suggestionId },
      relations: { suggester: true },
    });
    return this.emitAndReturnSuggestion(
      userId,
      tripId,
      fresh ?? suggestion,
      hasChange,
    );
  }

  /**
   * Upsert (suggestion_id, user_id) → vote inside the caller's
   * transaction so the write shares the same lock/visibility boundary
   * as the preceding status check.
   *
   * The write path races against concurrent votes from the same user
   * (double-tap, retry, multi-tab), so a naive read-then-insert can
   * lose the race and surface a 500 from the unique constraint. Do an
   * unconditional UPDATE first — if 0 rows were affected no vote
   * existed yet, so INSERT, and if *that* races with another insert
   * the unique violation is caught and we fall back to UPDATE one more
   * time. This leaves at most one row per (suggestion, user) and never
   * turns a normal retry into a server error.
   */
  private async upsertVoteIn(
    manager: EntityManager,
    suggestionId: string,
    userId: string,
    vote: 'up' | 'down',
  ): Promise<void> {
    const updated = await manager.update(
      TripSuggestionVote,
      { suggestion_id: suggestionId, user_id: userId },
      { vote },
    );
    if ((updated.affected ?? 0) > 0) return;

    try {
      await manager.insert(TripSuggestionVote, {
        suggestion_id: suggestionId,
        user_id: userId,
        vote,
      });
    } catch (err: unknown) {
      // A concurrent insert slipped in between our UPDATE and INSERT.
      // Desired post-state is still "one row for this member"; just
      // overwrite what they inserted with our vote value.
      if (!isUniqueViolation(err)) throw err;
      await manager.update(
        TripSuggestionVote,
        { suggestion_id: suggestionId, user_id: userId },
        { vote },
      );
    }
  }

  async unvoteSuggestion(
    userId: string,
    tripId: string,
    suggestionId: string,
  ): Promise<SuggestionDto> {
    await this.requireContributor(userId, tripId);

    // Mirrors `voteSuggestion`: pessimistic_write lock serializes
    // against a concurrent resolve so a late retry can't delete a vote
    // row (and fan out `trip:suggestion:voted`) on a now-closed
    // suggestion.
    const { suggestion, hasChange } =
      await this.suggestionRepo.manager.transaction(async (manager) => {
        // No `relations` — same FOR UPDATE + LEFT JOIN restriction as
        // `voteSuggestion` above.
        const locked = await manager.findOne(TripSuggestion, {
          where: { id: suggestionId, trip_id: tripId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!locked) throw new NotFoundException('Suggestion not found');
        if (locked.status !== 'open') {
          throw new BadRequestException(
            `Cannot change votes on a ${locked.status} suggestion`,
          );
        }

        const deleted = await manager.delete(TripSuggestionVote, {
          suggestion_id: suggestionId,
          user_id: userId,
        });

        // Only broadcast a new tally if an actual row was removed.
        // Repeated unvote calls (double-tap, retry) after the first
        // one succeeds would otherwise keep pinging every subscriber
        // with the same numbers.
        const change = (deleted.affected ?? 0) > 0;
        return { suggestion: locked, hasChange: change };
      });

    if (hasChange) {
      await this.activity.recordSafe(
        tripId,
        userId,
        'suggestion_vote_removed',
        { suggestion_id: suggestionId, title: suggestion.title },
      );
    }

    // Re-read: mirrors `voteSuggestion`. Close the post-tx window
    // where a concurrent resolve can leave the response body stuck on
    // `status: 'open'`.
    const fresh = await this.suggestionRepo.findOne({
      where: { id: suggestionId },
      relations: { suggester: true },
    });
    return this.emitAndReturnSuggestion(
      userId,
      tripId,
      fresh ?? suggestion,
      hasChange,
    );
  }

  // ── Messages ─────────────────────────────────────────────────────

  async listMessages(
    userId: string,
    tripId: string,
    query: ListMessagesDto,
  ): Promise<MessageDto[]> {
    await this.requireMembership(userId, tripId);

    const limit = clamp(
      query.limit ?? DEFAULT_MESSAGE_PAGE_SIZE,
      1,
      MAX_MESSAGE_PAGE_SIZE,
    );

    // Keyset on (created_at DESC, id DESC). The cursor predicate is a
    // composite tuple comparison: `(created_at, id) < (:before, :before_id)`
    // so messages sharing a timestamp at a page boundary aren't dropped.
    // Matches the sort order exactly and lets the index
    // `(trip_id, created_at DESC, id DESC)` seek straight to the cursor.
    const qb = this.messageRepo
      .createQueryBuilder('m')
      .leftJoinAndSelect('m.author', 'author')
      .where('m.trip_id = :tripId', { tripId })
      .andWhere("m.moderation_status = 'visible'")
      .orderBy('m.created_at', 'DESC')
      .addOrderBy('m.id', 'DESC')
      .take(limit);

    if (query.before && query.before_id) {
      qb.andWhere('(m.created_at, m.id) < (:before, :beforeId)', {
        before: new Date(query.before),
        beforeId: query.before_id,
      });
    }

    const rows = await qb.getMany();
    return rows.map((m) => toMessageDto(m));
  }

  async createMessage(
    userId: string,
    tripId: string,
    dto: CreateMessageDto,
  ): Promise<MessageDto> {
    await this.requireMembership(userId, tripId);

    const saved = await this.messageRepo.save(
      this.messageRepo.create({
        trip_id: tripId,
        user_id: userId,
        body: dto.body,
      }),
    );

    const hydrated = await this.messageRepo.findOne({
      where: { id: saved.id },
      relations: { author: true },
    });
    if (!hydrated) {
      throw new NotFoundException('Message disappeared after create');
    }

    const response = toMessageDto(hydrated);
    this.events.emitToTrip(tripId, 'trip:message', response);
    return response;
  }

  // ── Helpers ──────────────────────────────────────────────────────

  /**
   * Ensures the caller is a member of the trip. Returns the membership
   * row so callers that need the role (e.g. delete-any permission) can
   * avoid a second lookup.
   *
   * Folds "trip doesn't exist" and "caller isn't a member" into the same
   * 404 so a non-member can't probe for trip IDs.
   */
  private async requireMembership(
    userId: string,
    tripId: string,
  ): Promise<TripMember> {
    const membership = await this.memberRepo.findOne({
      where: { trip_id: tripId, user_id: userId },
    });
    if (!membership) throw new NotFoundException('Trip not found');
    return membership;
  }

  /**
   * Membership guard for the write surface viewers don't get:
   * proposing suggestions and voting. Viewers can still read
   * everything and post messages (`comment`).
   */
  private async requireContributor(
    userId: string,
    tripId: string,
  ): Promise<TripMember> {
    const membership = await this.requireMembership(userId, tripId);
    if (membership.role === 'viewer') {
      throw new ForbiddenException(
        'Viewers can view and comment only — ask the trip owner for editor access',
      );
    }
    return membership;
  }

  private async emitAndReturnSuggestion(
    userId: string,
    tripId: string,
    suggestion: TripSuggestion,
    emit = true,
  ): Promise<SuggestionDto> {
    const votes = await this.voteRepo.find({
      where: { suggestion_id: suggestion.id },
    });
    let up = 0;
    let down = 0;
    let callerVote: 'up' | 'down' | null = null;
    for (const v of votes) {
      if (v.vote === 'up') up += 1;
      else down += 1;
      if (v.user_id === userId) callerVote = v.vote;
    }

    const response = toSuggestionDto(suggestion, { up, down }, callerVote);
    if (emit) {
      this.events.emitToTrip(tripId, 'trip:suggestion:voted', {
        suggestion_id: suggestion.id,
        up_votes: up,
        down_votes: down,
      });
    }
    return response;
  }
}

function toSuggestionDto(
  s: TripSuggestion,
  tally: { up: number; down: number },
  callerVote: 'up' | 'down' | null,
): SuggestionDto {
  const latLng = pointToLatLng(s.location);
  return {
    id: s.id,
    trip_id: s.trip_id,
    trip_day_id: s.trip_day_id,
    suggested_by: s.suggested_by,
    suggester_display_name: s.suggester?.display_name ?? 'Unknown rider',
    road_segment_id: s.road_segment_id,
    title: s.title,
    description: s.description,
    lat: latLng?.lat ?? null,
    lng: latLng?.lng ?? null,
    status: s.status,
    up_votes: tally.up,
    down_votes: tally.down,
    caller_vote: callerVote,
    created_at: s.created_at.toISOString(),
    updated_at: s.updated_at.toISOString(),
  };
}

function toMessageDto(m: TripMessage): MessageDto {
  return {
    id: m.id,
    trip_id: m.trip_id,
    user_id: m.user_id,
    author_display_name: m.author?.display_name ?? 'Unknown rider',
    body: m.body,
    created_at: m.created_at.toISOString(),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  );
}
