import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { In, Repository } from 'typeorm';
import { TripCollabService } from './trip-collab.service.js';
import { TripMember } from '../../entities/trip-member.entity.js';
import { TripSuggestion } from '../../entities/trip-suggestion.entity.js';
import { TripSuggestionVote } from '../../entities/trip-suggestion-vote.entity.js';
import { TripMessage } from '../../entities/trip-message.entity.js';
import { TripDay } from '../../entities/trip-day.entity.js';
import { RoadSegment } from '../../entities/road-segment.entity.js';
import { EventsGateway } from '../events/events.gateway.js';
import { TripActivityService } from '../trip-activity/trip-activity.service.js';

const TRIP_ID = '11111111-1111-1111-1111-111111111111';
const DAY_ID = '22222222-2222-2222-2222-222222222222';
const USER_ID = '00000000-0000-0000-0000-000000000001';
const OTHER_ID = '00000000-0000-0000-0000-000000000002';
const SUGGESTION_ID = '33333333-3333-3333-3333-333333333333';
const SEGMENT_ID = '55555555-5555-5555-5555-555555555555';
const NOW = new Date('2026-04-24T10:00:00Z');

function makeMembership(role: string, userId = USER_ID): TripMember {
  return {
    id: `m-${userId}`,
    trip_id: TRIP_ID,
    user_id: userId,
    role,
    joined_at: NOW,
  } as TripMember;
}

function makeSuggestion(
  overrides: Partial<TripSuggestion> = {},
): TripSuggestion {
  return {
    id: SUGGESTION_ID,
    trip_id: TRIP_ID,
    trip_day_id: null,
    suggested_by: USER_ID,
    road_segment_id: null,
    title: 'Detour via Pordoi',
    description: 'Better surface',
    location: null,
    status: 'open',
    created_at: NOW,
    updated_at: NOW,
    suggester: { display_name: 'Adam' },
    votes: [],
    ...overrides,
  } as unknown as TripSuggestion;
}

describe('TripCollabService', () => {
  let service: TripCollabService;
  let memberRepo: jest.Mocked<Repository<TripMember>>;
  let suggestionRepo: jest.Mocked<Repository<TripSuggestion>>;
  let voteRepo: jest.Mocked<Repository<TripSuggestionVote>>;
  let messageRepo: jest.Mocked<Repository<TripMessage>>;
  let dayRepo: jest.Mocked<Repository<TripDay>>;
  let roadSegmentRepo: jest.Mocked<Repository<RoadSegment>>;
  let events: jest.Mocked<Pick<EventsGateway, 'emitToTrip'>>;
  let activity: jest.Mocked<Pick<TripActivityService, 'recordSafe'>>;
  // Stand-in for the TypeORM EntityManager handed to the callback by
  // `suggestionRepo.manager.transaction`. Vote/unvote reads + writes
  // go through this so tests can assert the suggestion-row lock path.
  let txManager: {
    findOne: jest.Mock;
    update: jest.Mock;
    insert: jest.Mock;
    delete: jest.Mock;
  };

  beforeEach(async () => {
    memberRepo = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<TripMember>>;

    txManager = {
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 0 }),
      insert: jest.fn().mockResolvedValue({ identifiers: [{ id: 'v-1' }] }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    suggestionRepo = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest
        .fn()
        .mockImplementation((data: Partial<TripSuggestion>) => ({ ...data })),
      save: jest.fn().mockImplementation((entity: TripSuggestion) =>
        Promise.resolve({
          ...entity,
          id: entity.id ?? SUGGESTION_ID,
          created_at: NOW,
          updated_at: NOW,
        }),
      ),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      manager: {
        transaction: jest
          .fn()
          .mockImplementation(
            async (cb: (m: typeof txManager) => Promise<unknown>) =>
              cb(txManager),
          ),
      },
    } as unknown as jest.Mocked<Repository<TripSuggestion>>;

    voteRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      create: jest
        .fn()
        .mockImplementation((data: Partial<TripSuggestionVote>) => ({
          ...data,
        })),
      save: jest.fn().mockImplementation((entity: TripSuggestionVote) =>
        Promise.resolve({
          ...entity,
          id: entity.id ?? 'v-1',
        }),
      ),
      update: jest.fn().mockResolvedValue({ affected: 0 }),
      insert: jest.fn().mockResolvedValue({ identifiers: [{ id: 'v-1' }] }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    } as unknown as jest.Mocked<Repository<TripSuggestionVote>>;

    messageRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(),
      create: jest
        .fn()
        .mockImplementation((data: Partial<TripMessage>) => ({ ...data })),
      save: jest.fn().mockImplementation((entity: TripMessage) =>
        Promise.resolve({
          ...entity,
          id: entity.id ?? 'msg-1',
          created_at: NOW,
        }),
      ),
    } as unknown as jest.Mocked<Repository<TripMessage>>;

    dayRepo = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<TripDay>>;

    roadSegmentRepo = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<RoadSegment>>;

    events = { emitToTrip: jest.fn() };
    activity = { recordSafe: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TripCollabService,
        { provide: getRepositoryToken(TripMember), useValue: memberRepo },
        {
          provide: getRepositoryToken(TripSuggestion),
          useValue: suggestionRepo,
        },
        {
          provide: getRepositoryToken(TripSuggestionVote),
          useValue: voteRepo,
        },
        { provide: getRepositoryToken(TripMessage), useValue: messageRepo },
        { provide: getRepositoryToken(TripDay), useValue: dayRepo },
        {
          provide: getRepositoryToken(RoadSegment),
          useValue: roadSegmentRepo,
        },
        { provide: EventsGateway, useValue: events },
        { provide: TripActivityService, useValue: activity },
      ],
    }).compile();

    service = module.get(TripCollabService);
  });

  describe('listSuggestions', () => {
    it("rejects non-members with a 404 so trip ids can't be probed", async () => {
      memberRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.listSuggestions(OTHER_ID, TRIP_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(suggestionRepo.find).not.toHaveBeenCalled();
    });

    it('returns [] when the trip has no suggestions without firing the vote query', async () => {
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('member'));
      suggestionRepo.find.mockResolvedValueOnce([]);

      const result = await service.listSuggestions(USER_ID, TRIP_ID);

      expect(result).toEqual([]);
      expect(voteRepo.find).not.toHaveBeenCalled();
    });

    it('aggregates tallies and surfaces the callers own vote', async () => {
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('member'));
      suggestionRepo.find.mockResolvedValueOnce([
        makeSuggestion({ id: 'sug-1' }),
        makeSuggestion({ id: 'sug-2' }),
      ]);
      voteRepo.find.mockResolvedValueOnce([
        { suggestion_id: 'sug-1', user_id: USER_ID, vote: 'up' },
        { suggestion_id: 'sug-1', user_id: OTHER_ID, vote: 'up' },
        { suggestion_id: 'sug-1', user_id: 'user-3', vote: 'down' },
        { suggestion_id: 'sug-2', user_id: OTHER_ID, vote: 'down' },
      ] as unknown as TripSuggestionVote[]);

      const result = await service.listSuggestions(USER_ID, TRIP_ID);

      // Votes are fetched with a single `IN (...)` predicate instead
      // of an OR-chain of per-id equality checks so the planner can
      // hit the `suggestion_id` index in one scan regardless of how
      // many suggestions the trip has.
      expect(voteRepo.find).toHaveBeenCalledWith({
        where: { suggestion_id: In(['sug-1', 'sug-2']) },
      });

      expect(result[0]).toMatchObject({
        id: 'sug-1',
        up_votes: 2,
        down_votes: 1,
        caller_vote: 'up',
      });
      expect(result[1]).toMatchObject({
        id: 'sug-2',
        up_votes: 0,
        down_votes: 1,
        caller_vote: null,
      });
    });
  });

  describe('createSuggestion', () => {
    it('creates a whole-trip suggestion, emits to the trip room, and returns zero tallies', async () => {
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('member'));
      suggestionRepo.findOne.mockResolvedValueOnce(makeSuggestion());

      const result = await service.createSuggestion(USER_ID, TRIP_ID, {
        title: 'Detour via Pordoi',
        description: 'Better surface',
      });

      expect(suggestionRepo.save).toHaveBeenCalled();
      expect(events.emitToTrip).toHaveBeenCalledWith(
        TRIP_ID,
        'trip:suggestion:created',
        expect.objectContaining({
          id: SUGGESTION_ID,
          up_votes: 0,
          down_votes: 0,
          caller_vote: null,
        }),
      );
      expect(result.title).toBe('Detour via Pordoi');
    });

    it('persists lat/lng as a GeoJSON Point with lng-first coordinate order', async () => {
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('member'));
      suggestionRepo.findOne.mockResolvedValueOnce(
        makeSuggestion({
          location: { type: 'Point', coordinates: [11.34, 46.49] },
        }),
      );

      const result = await service.createSuggestion(USER_ID, TRIP_ID, {
        title: 'Marker',
        lat: 46.49,
        lng: 11.34,
      });

      expect(suggestionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          location: { type: 'Point', coordinates: [11.34, 46.49] },
        }),
      );
      expect(result.lat).toBe(46.49);
      expect(result.lng).toBe(11.34);
    });

    it('rejects a trip_day_id that belongs to a different trip', async () => {
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('member'));
      dayRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.createSuggestion(USER_ID, TRIP_ID, {
          title: 'Day scoped',
          trip_day_id: DAY_ID,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(suggestionRepo.save).not.toHaveBeenCalled();
    });

    it('rejects a non-existent road_segment_id with a 400 instead of letting the FK 23503 bubble as a 500', async () => {
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('member'));
      roadSegmentRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.createSuggestion(USER_ID, TRIP_ID, {
          title: 'Bad segment',
          road_segment_id: SEGMENT_ID,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(suggestionRepo.save).not.toHaveBeenCalled();
    });

    it('accepts a road_segment_id that exists', async () => {
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('member'));
      roadSegmentRepo.findOne.mockResolvedValueOnce({
        id: SEGMENT_ID,
      } as RoadSegment);
      suggestionRepo.findOne.mockResolvedValueOnce(
        makeSuggestion({ road_segment_id: SEGMENT_ID }),
      );

      const result = await service.createSuggestion(USER_ID, TRIP_ID, {
        title: 'Good segment',
        road_segment_id: SEGMENT_ID,
      });

      expect(result.road_segment_id).toBe(SEGMENT_ID);
    });

    it('accepts a trip_day_id that belongs to the same trip', async () => {
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('member'));
      dayRepo.findOne.mockResolvedValueOnce({
        id: DAY_ID,
        trip_id: TRIP_ID,
      } as TripDay);
      suggestionRepo.findOne.mockResolvedValueOnce(
        makeSuggestion({ trip_day_id: DAY_ID }),
      );

      const result = await service.createSuggestion(USER_ID, TRIP_ID, {
        title: 'Day 2 alt',
        trip_day_id: DAY_ID,
      });

      expect(result.trip_day_id).toBe(DAY_ID);
    });
  });

  describe('deleteSuggestion', () => {
    it('lets the author delete their own suggestion', async () => {
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('member'));
      suggestionRepo.findOne.mockResolvedValueOnce(makeSuggestion());

      await service.deleteSuggestion(USER_ID, TRIP_ID, SUGGESTION_ID);

      expect(suggestionRepo.delete).toHaveBeenCalledWith({ id: SUGGESTION_ID });
      expect(events.emitToTrip).toHaveBeenCalledWith(
        TRIP_ID,
        'trip:suggestion:deleted',
        { suggestion_id: SUGGESTION_ID },
      );
    });

    it('lets an owner delete someone elses suggestion', async () => {
      memberRepo.findOne.mockResolvedValueOnce(
        makeMembership('owner', OTHER_ID),
      );
      suggestionRepo.findOne.mockResolvedValueOnce(
        makeSuggestion({ suggested_by: USER_ID }),
      );

      await service.deleteSuggestion(OTHER_ID, TRIP_ID, SUGGESTION_ID);

      expect(suggestionRepo.delete).toHaveBeenCalled();
    });

    it('forbids a regular member from deleting someone elses suggestion', async () => {
      memberRepo.findOne.mockResolvedValueOnce(
        makeMembership('member', OTHER_ID),
      );
      suggestionRepo.findOne.mockResolvedValueOnce(
        makeSuggestion({ suggested_by: USER_ID }),
      );

      await expect(
        service.deleteSuggestion(OTHER_ID, TRIP_ID, SUGGESTION_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(suggestionRepo.delete).not.toHaveBeenCalled();
    });

    it('404s a suggestion that belongs to a different trip', async () => {
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('member'));
      suggestionRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.deleteSuggestion(USER_ID, TRIP_ID, SUGGESTION_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('voteSuggestion', () => {
    it('inserts a fresh vote when no row exists (update affects 0 rows)', async () => {
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('member'));
      // Locked suggestion row, then priorVote read (null = no prior).
      txManager.findOne
        .mockResolvedValueOnce(makeSuggestion())
        .mockResolvedValueOnce(null);
      txManager.update.mockResolvedValueOnce({
        affected: 0,
        raw: [],
        generatedMaps: [],
      });
      voteRepo.find.mockResolvedValueOnce([
        { suggestion_id: SUGGESTION_ID, user_id: USER_ID, vote: 'up' },
      ] as unknown as TripSuggestionVote[]);

      const result = await service.voteSuggestion(
        USER_ID,
        TRIP_ID,
        SUGGESTION_ID,
        'up',
      );

      // Lock acquired via pessimistic_write so a concurrent resolve
      // can't slip the suggestion into `accepted`/`rejected` between
      // our status check and the upsert.
      expect(txManager.findOne).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        expect.objectContaining({
          where: { id: SUGGESTION_ID, trip_id: TRIP_ID },
          lock: { mode: 'pessimistic_write' },
        }),
      );
      expect(txManager.update).toHaveBeenCalledWith(
        expect.anything(),
        { suggestion_id: SUGGESTION_ID, user_id: USER_ID },
        { vote: 'up' },
      );
      expect(txManager.insert).toHaveBeenCalledWith(expect.anything(), {
        suggestion_id: SUGGESTION_ID,
        user_id: USER_ID,
        vote: 'up',
      });
      expect(result.up_votes).toBe(1);
      expect(result.caller_vote).toBe('up');
      // Fresh vote = real state change = broadcast to subscribers.
      expect(events.emitToTrip).toHaveBeenCalledWith(
        TRIP_ID,
        'trip:suggestion:voted',
        expect.any(Object),
      );
    });

    it('does NOT emit trip:suggestion:voted when the caller re-submits the same vote value', async () => {
      // A double-tap on the already-selected vote shouldn't fan a
      // stale tally out to every subscriber — consistent with
      // unvoteSuggestion's same-state no-op behaviour.
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('member'));
      txManager.findOne
        .mockResolvedValueOnce(makeSuggestion())
        .mockResolvedValueOnce({
          suggestion_id: SUGGESTION_ID,
          user_id: USER_ID,
          vote: 'up',
        });
      txManager.update.mockResolvedValueOnce({
        affected: 1,
        raw: [],
        generatedMaps: [],
      });
      voteRepo.find.mockResolvedValueOnce([
        { suggestion_id: SUGGESTION_ID, user_id: USER_ID, vote: 'up' },
      ] as unknown as TripSuggestionVote[]);

      const result = await service.voteSuggestion(
        USER_ID,
        TRIP_ID,
        SUGGESTION_ID,
        'up',
      );

      expect(result.caller_vote).toBe('up');
      expect(events.emitToTrip).not.toHaveBeenCalled();
    });

    it('flips an existing vote with a single UPDATE (no INSERT)', async () => {
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('member'));
      txManager.findOne
        .mockResolvedValueOnce(makeSuggestion())
        .mockResolvedValueOnce({
          suggestion_id: SUGGESTION_ID,
          user_id: USER_ID,
          vote: 'up',
        });
      txManager.update.mockResolvedValueOnce({
        affected: 1,
        raw: [],
        generatedMaps: [],
      });
      voteRepo.find.mockResolvedValueOnce([
        { suggestion_id: SUGGESTION_ID, user_id: USER_ID, vote: 'down' },
      ] as unknown as TripSuggestionVote[]);

      const result = await service.voteSuggestion(
        USER_ID,
        TRIP_ID,
        SUGGESTION_ID,
        'down',
      );

      expect(txManager.update).toHaveBeenCalledWith(
        expect.anything(),
        { suggestion_id: SUGGESTION_ID, user_id: USER_ID },
        { vote: 'down' },
      );
      expect(txManager.insert).not.toHaveBeenCalled();
      expect(result.caller_vote).toBe('down');
      // A real flip → broadcast.
      expect(events.emitToTrip).toHaveBeenCalled();
    });

    it('recovers from a concurrent first-time vote race (23505 on INSERT)', async () => {
      // Both requests observe affected:0 from UPDATE, both try INSERT,
      // the second catches 23505 and overwrites with a final UPDATE.
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('member'));
      txManager.findOne
        .mockResolvedValueOnce(makeSuggestion())
        .mockResolvedValueOnce(null);
      txManager.update
        .mockResolvedValueOnce({ affected: 0, raw: [], generatedMaps: [] })
        .mockResolvedValueOnce({ affected: 1, raw: [], generatedMaps: [] });
      txManager.insert.mockRejectedValueOnce(
        Object.assign(new Error('duplicate key'), {
          code: '23505',
          constraint: 'uq_trip_suggestion_votes_member',
        }),
      );
      voteRepo.find.mockResolvedValueOnce([
        { suggestion_id: SUGGESTION_ID, user_id: USER_ID, vote: 'up' },
      ] as unknown as TripSuggestionVote[]);

      const result = await service.voteSuggestion(
        USER_ID,
        TRIP_ID,
        SUGGESTION_ID,
        'up',
      );

      // Two UPDATEs: first returns affected:0, fallback after the
      // caught 23505 returns affected:1.
      expect(txManager.update).toHaveBeenCalledTimes(2);
      expect(txManager.insert).toHaveBeenCalledTimes(1);
      expect(result.caller_vote).toBe('up');
    });

    it('rethrows non-unique-violation errors from the INSERT', async () => {
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('member'));
      txManager.findOne
        .mockResolvedValueOnce(makeSuggestion())
        .mockResolvedValueOnce(null);
      txManager.update.mockResolvedValueOnce({
        affected: 0,
        raw: [],
        generatedMaps: [],
      });
      txManager.insert.mockRejectedValueOnce(
        Object.assign(new Error('boom'), { code: '99999' }),
      );

      await expect(
        service.voteSuggestion(USER_ID, TRIP_ID, SUGGESTION_ID, 'up'),
      ).rejects.toThrow('boom');
    });

    it('rejects votes on a resolved suggestion (accepted / rejected)', async () => {
      // Once the owner resolves a suggestion the UI closes voting. The
      // check happens UNDER the row lock so a concurrent resolve
      // committing mid-vote forces our status read to see the final
      // value — no vote row is written and no broadcast fires.
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('member'));
      txManager.findOne.mockResolvedValueOnce(
        makeSuggestion({ status: 'accepted' }),
      );

      await expect(
        service.voteSuggestion(USER_ID, TRIP_ID, SUGGESTION_ID, 'up'),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(txManager.update).not.toHaveBeenCalled();
      expect(txManager.insert).not.toHaveBeenCalled();
      expect(events.emitToTrip).not.toHaveBeenCalled();
    });

    it('surfaces a resolve that committed in the post-tx window (response reflects the fresh status)', async () => {
      // The vote tx committed while the suggestion was still 'open',
      // but before we assemble the HTTP response an owner resolves the
      // row to 'accepted'. Without the post-tx re-read the voter would
      // get a DTO with status 'open' and their UI would briefly
      // re-enable vote controls on a finalised row.
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('member'));
      txManager.findOne
        .mockResolvedValueOnce(makeSuggestion())
        .mockResolvedValueOnce(null);
      txManager.update.mockResolvedValueOnce({
        affected: 0,
        raw: [],
        generatedMaps: [],
      });
      // Fresh re-read after the tx commits: status has flipped.
      suggestionRepo.findOne.mockResolvedValueOnce(
        makeSuggestion({ status: 'accepted' }),
      );
      voteRepo.find.mockResolvedValueOnce([
        { suggestion_id: SUGGESTION_ID, user_id: USER_ID, vote: 'up' },
      ] as unknown as TripSuggestionVote[]);

      const result = await service.voteSuggestion(
        USER_ID,
        TRIP_ID,
        SUGGESTION_ID,
        'up',
      );

      expect(suggestionRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: SUGGESTION_ID },
          relations: { suggester: true },
        }),
      );
      expect(result.status).toBe('accepted');
    });
  });

  describe('unvoteSuggestion', () => {
    it('removes the callers vote and re-emits the tally when a row was actually deleted', async () => {
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('member'));
      txManager.findOne.mockResolvedValueOnce(makeSuggestion());
      txManager.delete.mockResolvedValueOnce({ affected: 1, raw: [] });
      voteRepo.find.mockResolvedValueOnce([]);

      const result = await service.unvoteSuggestion(
        USER_ID,
        TRIP_ID,
        SUGGESTION_ID,
      );

      expect(txManager.findOne).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          lock: { mode: 'pessimistic_write' },
        }),
      );
      expect(txManager.delete).toHaveBeenCalledWith(expect.anything(), {
        suggestion_id: SUGGESTION_ID,
        user_id: USER_ID,
      });
      expect(result.caller_vote).toBeNull();
      expect(events.emitToTrip).toHaveBeenCalledWith(
        TRIP_ID,
        'trip:suggestion:voted',
        { suggestion_id: SUGGESTION_ID, up_votes: 0, down_votes: 0 },
      );
    });

    it('does NOT emit trip:suggestion:voted when there was no prior vote to delete', async () => {
      // A no-op unvote (double-tap, retry after first success) shouldn't
      // force every subscribed member to refetch a tally that didn't
      // actually change.
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('member'));
      txManager.findOne.mockResolvedValueOnce(makeSuggestion());
      txManager.delete.mockResolvedValueOnce({ affected: 0, raw: [] });
      voteRepo.find.mockResolvedValueOnce([]);

      const result = await service.unvoteSuggestion(
        USER_ID,
        TRIP_ID,
        SUGGESTION_ID,
      );

      // Caller still gets the current state back so they can reconcile,
      // but no broadcast is fired.
      expect(result.caller_vote).toBeNull();
      expect(events.emitToTrip).not.toHaveBeenCalled();
    });

    it('rejects unvote on a resolved suggestion', async () => {
      // Mirrors voteSuggestion: under the row lock the status read
      // reflects any concurrent resolve, so a late retry can't delete
      // a vote row on a now-closed suggestion.
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('member'));
      txManager.findOne.mockResolvedValueOnce(
        makeSuggestion({ status: 'rejected' }),
      );

      await expect(
        service.unvoteSuggestion(USER_ID, TRIP_ID, SUGGESTION_ID),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(txManager.delete).not.toHaveBeenCalled();
      expect(events.emitToTrip).not.toHaveBeenCalled();
    });
  });

  describe('resolveSuggestion', () => {
    it('flips status via conditional UPDATE and broadcasts trip:suggestion:resolved', async () => {
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('owner'));
      suggestionRepo.update.mockResolvedValueOnce({
        affected: 1,
        raw: [],
        generatedMaps: [],
      });
      suggestionRepo.findOne.mockResolvedValueOnce(
        makeSuggestion({ status: 'accepted' }),
      );
      voteRepo.find.mockResolvedValueOnce([]);

      const result = await service.resolveSuggestion(
        USER_ID,
        TRIP_ID,
        SUGGESTION_ID,
        'accepted',
      );

      // Atomic WHERE status = 'open' guarantees at most one resolver
      // wins even under concurrent owner/admin requests.
      expect(suggestionRepo.update).toHaveBeenCalledWith(
        { id: SUGGESTION_ID, trip_id: TRIP_ID, status: 'open' },
        { status: 'accepted' },
      );
      expect(events.emitToTrip).toHaveBeenCalledWith(
        TRIP_ID,
        'trip:suggestion:resolved',
        { suggestion_id: SUGGESTION_ID, status: 'accepted' },
      );
      expect(result.status).toBe('accepted');
    });

    it('rejects a concurrent second resolve (affected = 0, already resolved)', async () => {
      // Simulate the loser of a resolve race: the conditional UPDATE
      // finds no row matching `status = 'open'` because the winner has
      // already committed. Instead of silently overwriting the winner's
      // decision and emitting a conflicting broadcast, we disambiguate
      // via a second read and 400 with the now-authoritative status.
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('owner'));
      suggestionRepo.update.mockResolvedValueOnce({
        affected: 0,
        raw: [],
        generatedMaps: [],
      });
      suggestionRepo.findOne.mockResolvedValueOnce(
        makeSuggestion({ status: 'rejected' }),
      );

      await expect(
        service.resolveSuggestion(USER_ID, TRIP_ID, SUGGESTION_ID, 'accepted'),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(events.emitToTrip).not.toHaveBeenCalled();
    });

    it('404s a suggestion that does not exist (affected = 0 with no follow-up row)', async () => {
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('owner'));
      suggestionRepo.update.mockResolvedValueOnce({
        affected: 0,
        raw: [],
        generatedMaps: [],
      });
      suggestionRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.resolveSuggestion(USER_ID, TRIP_ID, SUGGESTION_ID, 'accepted'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(events.emitToTrip).not.toHaveBeenCalled();
    });

    it('forbids viewers from resolving', async () => {
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('viewer'));

      await expect(
        service.resolveSuggestion(USER_ID, TRIP_ID, SUGGESTION_ID, 'accepted'),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // Guard short-circuits BEFORE the conditional UPDATE so a plain
      // member can't even probe whether the row is open.
      expect(suggestionRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('moderation is owner + editor', () => {
    it('lets editors resolve suggestions', async () => {
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('editor'));
      suggestionRepo.update.mockResolvedValueOnce({
        affected: 1,
        raw: [],
        generatedMaps: [],
      });
      suggestionRepo.findOne.mockResolvedValueOnce(
        makeSuggestion({ status: 'accepted' }),
      );
      await expect(
        service.resolveSuggestion(USER_ID, TRIP_ID, SUGGESTION_ID, 'accepted'),
      ).resolves.toMatchObject({ status: 'accepted' });
      expect(suggestionRepo.update).toHaveBeenCalled();
    });

    it('lets editors reopen suggestions', async () => {
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('editor'));
      suggestionRepo.update.mockResolvedValueOnce({
        affected: 1,
        raw: [],
        generatedMaps: [],
      });
      suggestionRepo.findOne.mockResolvedValueOnce(
        makeSuggestion({ status: 'open' }),
      );
      await expect(
        service.reopenSuggestion(USER_ID, TRIP_ID, SUGGESTION_ID),
      ).resolves.toMatchObject({ status: 'open' });
      expect(suggestionRepo.update).toHaveBeenCalled();
    });

    it('forbids viewers from resolving suggestions', async () => {
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('viewer'));
      await expect(
        service.resolveSuggestion(USER_ID, TRIP_ID, SUGGESTION_ID, 'accepted'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(suggestionRepo.update).not.toHaveBeenCalled();
    });

    it("forbids editors from deleting other riders' suggestions", async () => {
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('editor'));
      suggestionRepo.findOne.mockResolvedValueOnce(
        makeSuggestion({ suggested_by: OTHER_ID }),
      );
      await expect(
        service.deleteSuggestion(USER_ID, TRIP_ID, SUGGESTION_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(suggestionRepo.delete).not.toHaveBeenCalled();
    });
  });

  describe('viewer role gating', () => {
    it('lets viewers propose suggestions', async () => {
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('viewer'));
      suggestionRepo.findOne.mockResolvedValueOnce(makeSuggestion());
      await expect(
        service.createSuggestion(USER_ID, TRIP_ID, { title: 'Detour' }),
      ).resolves.toMatchObject({ id: SUGGESTION_ID });
      expect(suggestionRepo.save).toHaveBeenCalled();
    });

    it('still lets viewers post messages (comment)', async () => {
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('viewer'));
      const message = {
        id: 'msg-1',
        trip_id: TRIP_ID,
        user_id: USER_ID,
        body: 'hello',
        moderation_status: 'visible',
        created_at: NOW,
        author: { id: USER_ID, display_name: 'Eve' },
      } as unknown as TripMessage;
      messageRepo.create.mockImplementation((d) => d as TripMessage);
      messageRepo.save.mockResolvedValueOnce(message);
      // createMessage re-reads with the author relation after saving.
      messageRepo.findOne.mockResolvedValueOnce(message);

      await expect(
        service.createMessage(USER_ID, TRIP_ID, { body: 'hello' }),
      ).resolves.toMatchObject({ body: 'hello' });
    });
  });

  describe('reopenSuggestion', () => {
    it('flips a resolved row back to open, records activity, and broadcasts', async () => {
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('owner'));
      suggestionRepo.update.mockResolvedValueOnce({
        affected: 1,
        raw: [],
        generatedMaps: [],
      });
      suggestionRepo.findOne.mockResolvedValueOnce(
        makeSuggestion({ status: 'open' }),
      );
      voteRepo.find.mockResolvedValueOnce([]);

      const result = await service.reopenSuggestion(
        USER_ID,
        TRIP_ID,
        SUGGESTION_ID,
      );

      // Conditional on the row being resolved, so a double-click can't
      // fan out duplicate broadcasts for an already-open suggestion.
      expect(suggestionRepo.update).toHaveBeenCalledWith(
        {
          id: SUGGESTION_ID,
          trip_id: TRIP_ID,
          status: In(['accepted', 'rejected']),
        },
        { status: 'open' },
      );
      expect(activity.recordSafe).toHaveBeenCalledWith(
        TRIP_ID,
        USER_ID,
        'suggestion_reopened',
        expect.objectContaining({ suggestion_id: SUGGESTION_ID }),
      );
      expect(events.emitToTrip).toHaveBeenCalledWith(
        TRIP_ID,
        'trip:suggestion:resolved',
        { suggestion_id: SUGGESTION_ID, status: 'open' },
      );
      expect(result.status).toBe('open');
    });

    it('400s when the suggestion is already open (affected = 0)', async () => {
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('owner'));
      suggestionRepo.update.mockResolvedValueOnce({
        affected: 0,
        raw: [],
        generatedMaps: [],
      });
      suggestionRepo.findOne.mockResolvedValueOnce(
        makeSuggestion({ status: 'open' }),
      );

      await expect(
        service.reopenSuggestion(USER_ID, TRIP_ID, SUGGESTION_ID),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(events.emitToTrip).not.toHaveBeenCalled();
    });

    it('404s a suggestion that does not exist', async () => {
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('owner'));
      suggestionRepo.update.mockResolvedValueOnce({
        affected: 0,
        raw: [],
        generatedMaps: [],
      });
      suggestionRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.reopenSuggestion(USER_ID, TRIP_ID, SUGGESTION_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('forbids non-owner/admin members from reopening', async () => {
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('member'));

      await expect(
        service.reopenSuggestion(USER_ID, TRIP_ID, SUGGESTION_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(suggestionRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('listMessages', () => {
    type MessagesQbMock = {
      leftJoinAndSelect: jest.Mock;
      where: jest.Mock;
      andWhere: jest.Mock;
      orderBy: jest.Mock;
      addOrderBy: jest.Mock;
      take: jest.Mock;
      getMany: jest.Mock;
    };

    function mockMessagesQb(rows: TripMessage[] = []): MessagesQbMock {
      const qb = {
        leftJoinAndSelect: jest.fn(),
        where: jest.fn(),
        andWhere: jest.fn(),
        orderBy: jest.fn(),
        addOrderBy: jest.fn(),
        take: jest.fn(),
        getMany: jest.fn().mockResolvedValue(rows),
      };
      for (const fn of [
        'leftJoinAndSelect',
        'where',
        'andWhere',
        'orderBy',
        'addOrderBy',
        'take',
      ] as const) {
        (qb as unknown as Record<string, jest.Mock>)[fn]!.mockReturnValue(qb);
      }
      (messageRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);
      return qb;
    }

    it("404s non-members so we don't leak that the trip exists", async () => {
      memberRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.listMessages(OTHER_ID, TRIP_ID, {}),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('applies the default page size and only the moderation filter when no cursor is given', async () => {
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('member'));
      const qb = mockMessagesQb();

      await service.listMessages(USER_ID, TRIP_ID, {});

      expect(qb.take).toHaveBeenCalledWith(50);
      // The only andWhere call at this point is the moderation-status filter;
      // no keyset-cursor predicate is added when no before/before_id are given.
      expect(qb.andWhere).toHaveBeenCalledTimes(1);
      expect(qb.andWhere).toHaveBeenCalledWith(
        "m.moderation_status = 'visible'",
      );
    });

    it('clamps limit to the server maximum', async () => {
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('member'));
      const qb = mockMessagesQb();

      await service.listMessages(USER_ID, TRIP_ID, { limit: 1000 });

      expect(qb.take).toHaveBeenCalledWith(100);
    });

    it('applies a composite (created_at, id) cursor when before + before_id are provided', async () => {
      // Tuple comparison is what prevents messages with tied timestamps
      // from being silently skipped at a page boundary.
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('member'));
      const qb = mockMessagesQb();

      await service.listMessages(USER_ID, TRIP_ID, {
        before: '2026-04-24T09:00:00.000Z',
        before_id: '123e4567-e89b-42d3-a456-556642440000',
      });

      expect(qb.andWhere).toHaveBeenCalledWith(
        '(m.created_at, m.id) < (:before, :beforeId)',
        {
          before: new Date('2026-04-24T09:00:00.000Z'),
          beforeId: '123e4567-e89b-42d3-a456-556642440000',
        },
      );
    });

    it('orders newest-first on (created_at DESC, id DESC) — matching the composite index', async () => {
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('member'));
      const qb = mockMessagesQb();

      await service.listMessages(USER_ID, TRIP_ID, {});

      expect(qb.orderBy).toHaveBeenCalledWith('m.created_at', 'DESC');
      expect(qb.addOrderBy).toHaveBeenCalledWith('m.id', 'DESC');
    });

    it('listMessages excludes hidden messages', async () => {
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('member'));
      const qb = mockMessagesQb();

      await service.listMessages(USER_ID, TRIP_ID, {});

      expect(qb.andWhere).toHaveBeenCalledWith(
        "m.moderation_status = 'visible'",
      );
    });
  });

  describe('createMessage', () => {
    it('persists, emits, and returns the hydrated message', async () => {
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('member'));
      messageRepo.findOne.mockResolvedValueOnce({
        id: 'msg-1',
        trip_id: TRIP_ID,
        user_id: USER_ID,
        body: 'hi',
        created_at: NOW,
        author: { display_name: 'Adam' },
      } as unknown as TripMessage);

      const result = await service.createMessage(USER_ID, TRIP_ID, {
        body: 'hi',
      });

      expect(messageRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          trip_id: TRIP_ID,
          user_id: USER_ID,
          body: 'hi',
        }),
      );
      expect(events.emitToTrip).toHaveBeenCalledWith(
        TRIP_ID,
        'trip:message',
        expect.objectContaining({
          body: 'hi',
          author_display_name: 'Adam',
        }),
      );
      expect(result.body).toBe('hi');
    });
  });
});
