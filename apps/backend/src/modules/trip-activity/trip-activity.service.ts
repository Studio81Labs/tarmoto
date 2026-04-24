import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  TripActivity,
  TripActivityAction,
} from '../../entities/trip-activity.entity.js';
import { TripMember } from '../../entities/trip-member.entity.js';
import { User } from '../../entities/user.entity.js';
import { EventsGateway } from '../events/events.gateway.js';
import {
  TripActivityEntryDto,
  TripActivityListResponseDto,
} from './dto/activity-response.dto.js';

const MAX_ACTIVITY_LIMIT = 200;
const DEFAULT_ACTIVITY_LIMIT = 100;

/**
 * Writes and reads activity entries for a trip. Writes also broadcast
 * the entry to the live trip room via `EventsGateway.emitToTrip` so the
 * companion's activity tab updates without a refetch.
 *
 * The broadcast is best-effort — a socket failure must never fail the
 * underlying DB mutation, so callers wrap `record()` in their own
 * transaction if ordering matters.
 */
@Injectable()
export class TripActivityService {
  constructor(
    @InjectRepository(TripActivity)
    private readonly activityRepo: Repository<TripActivity>,
    @InjectRepository(TripMember)
    private readonly memberRepo: Repository<TripMember>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly events: EventsGateway,
  ) {}

  async record(
    tripId: string,
    actorId: string | null,
    action: TripActivityAction,
    payload: Record<string, unknown> = {},
  ): Promise<TripActivity> {
    const entry = await this.activityRepo.save(
      this.activityRepo.create({
        trip_id: tripId,
        actor_id: actorId,
        action,
        payload,
      }),
    );
    // Resolve the actor's display_name so the broadcast payload matches
    // the REST `list` response shape — otherwise the companion's live
    // timeline renders every entry as "System" until the next refetch.
    const actorName = actorId ? await this.resolveActorName(actorId) : null;
    this.events.emitToTrip(
      tripId,
      'trip:activity',
      this.toDto(entry, actorName),
    );
    return entry;
  }

  async list(
    userId: string,
    tripId: string,
    limit = DEFAULT_ACTIVITY_LIMIT,
  ): Promise<TripActivityListResponseDto> {
    // Membership check collapses "no trip" and "not a member" into the
    // same 404 — mirrors the policy used by the main TripsService so the
    // activity endpoint can't be used to enumerate trip ids.
    const membership = await this.memberRepo.findOne({
      where: { trip_id: tripId, user_id: userId },
    });
    if (!membership) {
      throw new NotFoundException('Trip not found');
    }
    const bounded = Math.min(Math.max(limit, 1), MAX_ACTIVITY_LIMIT);
    const rows = await this.activityRepo.find({
      where: { trip_id: tripId },
      relations: ['actor'],
      order: { created_at: 'DESC' },
      take: bounded,
    });
    return {
      activity: rows.map((row) =>
        this.toDto(row, row.actor?.display_name ?? null),
      ),
    };
  }

  private async resolveActorName(actorId: string): Promise<string | null> {
    const user = await this.userRepo.findOne({ where: { id: actorId } });
    return user?.display_name ?? null;
  }

  private toDto(
    entry: TripActivity,
    actorName: string | null,
  ): TripActivityEntryDto {
    return {
      id: entry.id,
      trip_id: entry.trip_id,
      actor_id: entry.actor_id,
      actor_name: actorName,
      action: entry.action,
      payload: entry.payload ?? {},
      created_at: entry.created_at.toISOString(),
    };
  }
}
