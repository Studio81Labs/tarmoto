/* eslint-disable @typescript-eslint/unbound-method */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { TripCollabService } from './trip-collab.service.js';
import { TripMember } from '../../entities/trip-member.entity.js';
import { TripSuggestion } from '../../entities/trip-suggestion.entity.js';
import { TripSuggestionVote } from '../../entities/trip-suggestion-vote.entity.js';
import { TripMessage } from '../../entities/trip-message.entity.js';
import { TripDay } from '../../entities/trip-day.entity.js';
import { RoadSegment } from '../../entities/road-segment.entity.js';
import { EventsGateway } from '../events/events.gateway.js';

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

  beforeEach(async () => {
    memberRepo = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<TripMember>>;

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
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
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
      suggestionRepo.findOne.mockResolvedValueOnce(makeSuggestion());
      voteRepo.update.mockResolvedValueOnce({
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

      expect(voteRepo.update).toHaveBeenCalledWith(
        { suggestion_id: SUGGESTION_ID, user_id: USER_ID },
        { vote: 'up' },
      );
      expect(voteRepo.insert).toHaveBeenCalledWith({
        suggestion_id: SUGGESTION_ID,
        user_id: USER_ID,
        vote: 'up',
      });
      expect(result.up_votes).toBe(1);
      expect(result.caller_vote).toBe('up');
    });

    it('flips an existing vote with a single UPDATE (no INSERT)', async () => {
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('member'));
      suggestionRepo.findOne.mockResolvedValueOnce(makeSuggestion());
      voteRepo.update.mockResolvedValueOnce({
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

      expect(voteRepo.update).toHaveBeenCalledWith(
        { suggestion_id: SUGGESTION_ID, user_id: USER_ID },
        { vote: 'down' },
      );
      expect(voteRepo.insert).not.toHaveBeenCalled();
      expect(result.caller_vote).toBe('down');
    });

    it('recovers from a concurrent first-time vote race (23505 on INSERT)', async () => {
      // Both requests observe affected:0 from UPDATE, both try INSERT,
      // the second catches 23505 and overwrites with a final UPDATE.
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('member'));
      suggestionRepo.findOne.mockResolvedValueOnce(makeSuggestion());
      voteRepo.update
        .mockResolvedValueOnce({ affected: 0, raw: [], generatedMaps: [] })
        .mockResolvedValueOnce({ affected: 1, raw: [], generatedMaps: [] });
      voteRepo.insert.mockRejectedValueOnce(
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
      expect(voteRepo.update).toHaveBeenCalledTimes(2);
      expect(voteRepo.insert).toHaveBeenCalledTimes(1);
      expect(result.caller_vote).toBe('up');
    });

    it('rethrows non-unique-violation errors from the INSERT', async () => {
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('member'));
      suggestionRepo.findOne.mockResolvedValueOnce(makeSuggestion());
      voteRepo.update.mockResolvedValueOnce({
        affected: 0,
        raw: [],
        generatedMaps: [],
      });
      voteRepo.insert.mockRejectedValueOnce(
        Object.assign(new Error('boom'), { code: '99999' }),
      );

      await expect(
        service.voteSuggestion(USER_ID, TRIP_ID, SUGGESTION_ID, 'up'),
      ).rejects.toThrow('boom');
    });
  });

  describe('unvoteSuggestion', () => {
    it('removes the callers vote and re-emits the tally', async () => {
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('member'));
      suggestionRepo.findOne.mockResolvedValueOnce(makeSuggestion());
      voteRepo.find.mockResolvedValueOnce([]);

      const result = await service.unvoteSuggestion(
        USER_ID,
        TRIP_ID,
        SUGGESTION_ID,
      );

      expect(voteRepo.delete).toHaveBeenCalledWith({
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
      } as MessagesQbMock;
      for (const fn of [
        'leftJoinAndSelect',
        'where',
        'andWhere',
        'orderBy',
        'addOrderBy',
        'take',
      ] as const) {
        (qb as unknown as Record<string, jest.Mock>)[fn].mockReturnValue(qb);
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

    it('applies the default page size and no cursor predicate when none given', async () => {
      memberRepo.findOne.mockResolvedValueOnce(makeMembership('member'));
      const qb = mockMessagesQb();

      await service.listMessages(USER_ID, TRIP_ID, {});

      expect(qb.take).toHaveBeenCalledWith(50);
      expect(qb.andWhere).not.toHaveBeenCalled();
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
