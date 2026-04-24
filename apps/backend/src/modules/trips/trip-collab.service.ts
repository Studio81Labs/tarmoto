import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TripMember } from '../../entities/trip-member.entity.js';
import { TripSuggestion } from '../../entities/trip-suggestion.entity.js';
import { TripSuggestionVote } from '../../entities/trip-suggestion-vote.entity.js';
import { TripMessage } from '../../entities/trip-message.entity.js';
import { TripDay } from '../../entities/trip-day.entity.js';
import { EventsGateway } from '../events/events.gateway.js';
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
const PRIVILEGED_ROLES = new Set(['owner', 'admin']);

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
    private readonly events: EventsGateway,
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
    const votes = await this.voteRepo.find({
      where: ids.map((id) => ({ suggestion_id: id })),
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
    await this.requireMembership(userId, tripId);

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
  }

  async voteSuggestion(
    userId: string,
    tripId: string,
    suggestionId: string,
    vote: 'up' | 'down',
  ): Promise<SuggestionDto> {
    await this.requireMembership(userId, tripId);
    const suggestion = await this.suggestionRepo.findOne({
      where: { id: suggestionId, trip_id: tripId },
      relations: { suggester: true },
    });
    if (!suggestion) throw new NotFoundException('Suggestion not found');

    // Upsert against (suggestion_id, user_id) — changing a vote is an
    // UPDATE, not a new row, so the vote tally stays well-defined.
    //
    // The write path races against concurrent votes from the same user
    // (double-tap, retry, multi-tab), so a naive read-then-insert can
    // lose the race and surface a 500 from the unique constraint. Do an
    // unconditional UPDATE first — if 0 rows were affected no vote
    // existed yet, so INSERT, and if *that* races with another insert
    // the unique violation is caught and we fall back to UPDATE one
    // more time. This leaves at most one row per (suggestion, user) and
    // never turns a normal retry into a server error.
    await this.upsertVote(suggestionId, userId, vote);

    return this.emitAndReturnSuggestion(userId, tripId, suggestion);
  }

  private async upsertVote(
    suggestionId: string,
    userId: string,
    vote: 'up' | 'down',
  ): Promise<void> {
    const updated = await this.voteRepo.update(
      { suggestion_id: suggestionId, user_id: userId },
      { vote },
    );
    if ((updated.affected ?? 0) > 0) return;

    try {
      await this.voteRepo.insert({
        suggestion_id: suggestionId,
        user_id: userId,
        vote,
      });
    } catch (err: unknown) {
      // A concurrent insert slipped in between our UPDATE and INSERT.
      // Desired post-state is still "one row for this member"; just
      // overwrite what they inserted with our vote value.
      if (!isUniqueViolation(err)) throw err;
      await this.voteRepo.update(
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
    await this.requireMembership(userId, tripId);
    const suggestion = await this.suggestionRepo.findOne({
      where: { id: suggestionId, trip_id: tripId },
      relations: { suggester: true },
    });
    if (!suggestion) throw new NotFoundException('Suggestion not found');

    await this.voteRepo.delete({
      suggestion_id: suggestionId,
      user_id: userId,
    });

    return this.emitAndReturnSuggestion(userId, tripId, suggestion);
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

  private async emitAndReturnSuggestion(
    userId: string,
    tripId: string,
    suggestion: TripSuggestion,
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
    this.events.emitToTrip(tripId, 'trip:suggestion:voted', {
      suggestion_id: suggestion.id,
      up_votes: up,
      down_votes: down,
    });
    return response;
  }
}

function toSuggestionDto(
  s: TripSuggestion,
  tally: { up: number; down: number },
  callerVote: 'up' | 'down' | null,
): SuggestionDto {
  const latLng = pointFromGeometry(s.location);
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

function pointFromGeometry(geom: unknown): { lat: number; lng: number } | null {
  if (!geom || typeof geom !== 'object') return null;
  const coords = (geom as { coordinates?: unknown }).coordinates;
  if (
    !Array.isArray(coords) ||
    typeof coords[0] !== 'number' ||
    typeof coords[1] !== 'number'
  ) {
    return null;
  }
  return { lat: coords[1], lng: coords[0] };
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
