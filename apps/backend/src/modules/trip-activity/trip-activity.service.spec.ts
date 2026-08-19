import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { TripActivity } from '../../entities/trip-activity.entity.js';
import { TripMember } from '../../entities/trip-member.entity.js';
import { User } from '../../entities/user.entity.js';
import { EventsGateway } from '../events/events.gateway.js';
import { PushService } from '../push/index.js';
import { TripActivityService } from './trip-activity.service.js';

const TRIP_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

describe('TripActivityService', () => {
  let service: TripActivityService;
  let activityRepo: jest.Mocked<Repository<TripActivity>>;
  let memberRepo: jest.Mocked<Repository<TripMember>>;
  let userRepo: jest.Mocked<Repository<User>>;
  let events: jest.Mocked<Pick<EventsGateway, 'emitToTrip'>>;

  beforeEach(async () => {
    activityRepo = {
      create: jest.fn().mockImplementation((data: Partial<TripActivity>) => ({
        ...data,
      })),
      save: jest.fn().mockImplementation((entity: TripActivity) =>
        Promise.resolve({
          ...entity,
          id: 'a-1',
          created_at: new Date('2026-04-24T10:00:00Z'),
        }),
      ),
      find: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<Repository<TripActivity>>;

    memberRepo = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<TripMember>>;

    userRepo = {
      findOne: jest.fn().mockResolvedValue({ display_name: 'Adam' }),
    } as unknown as jest.Mocked<Repository<User>>;

    events = { emitToTrip: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TripActivityService,
        { provide: getRepositoryToken(TripActivity), useValue: activityRepo },
        { provide: getRepositoryToken(TripMember), useValue: memberRepo },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: EventsGateway, useValue: events },
        {
          provide: PushService,
          useValue: {
            sendToUser: jest.fn().mockResolvedValue(undefined),
            sendToUsers: jest
              .fn()
              .mockResolvedValue({ delivered: 0, pruned: 0, users: 0 }),
          },
        },
      ],
    }).compile();

    service = module.get(TripActivityService);
  });

  describe('record', () => {
    it('persists an entry and broadcasts trip:activity with the resolved actor name', async () => {
      const saved = await service.record(TRIP_ID, USER_ID, 'member_joined', {
        role: 'member',
      });

      expect(activityRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          trip_id: TRIP_ID,
          actor_id: USER_ID,
          action: 'member_joined',
          payload: { role: 'member' },
        }),
      );
      // Actor name is resolved so realtime entries don't regress to
      // "System" labels until the next REST refetch.
      expect(userRepo.findOne).toHaveBeenCalledWith({
        where: { id: USER_ID },
      });
      expect(events.emitToTrip).toHaveBeenCalledWith(
        TRIP_ID,
        'trip:activity',
        expect.objectContaining({
          id: saved.id,
          trip_id: TRIP_ID,
          action: 'member_joined',
          actor_id: USER_ID,
          actor_name: 'Adam',
        }),
      );
    });

    it('skips the user lookup and emits null actor_name when actorId is null (system entries)', async () => {
      await service.record(TRIP_ID, null, 'member_left', {});
      expect(userRepo.findOne).not.toHaveBeenCalled();
      expect(events.emitToTrip).toHaveBeenCalledWith(
        TRIP_ID,
        'trip:activity',
        expect.objectContaining({ actor_id: null, actor_name: null }),
      );
    });

    it('falls back to null actor_name when the user was deleted', async () => {
      userRepo.findOne.mockResolvedValueOnce(null);
      await service.record(TRIP_ID, USER_ID, 'member_joined', {});
      expect(events.emitToTrip).toHaveBeenCalledWith(
        TRIP_ID,
        'trip:activity',
        expect.objectContaining({ actor_name: null }),
      );
    });
  });

  describe('recordSafe', () => {
    it('swallows persistence failures so the primary mutation response is not misreported', async () => {
      // The domain mutation (suggestion create, vote, trip update, …)
      // has already been saved and broadcast by the time its activity
      // entry is attempted, so a transient failure on the audit write
      // must not bubble out as a 500 — the caller would think the
      // mutation itself failed and retry, producing duplicates.
      activityRepo.save.mockRejectedValueOnce(new Error('db down'));

      await expect(
        service.recordSafe(TRIP_ID, USER_ID, 'suggestion_created', {
          suggestion_id: 's-1',
        }),
      ).resolves.toBeUndefined();

      // No broadcast when the persist fails.
      expect(events.emitToTrip).not.toHaveBeenCalled();
    });

    it('delegates to record() on the happy path', async () => {
      await service.recordSafe(TRIP_ID, USER_ID, 'suggestion_created', {
        suggestion_id: 's-1',
      });
      expect(activityRepo.save).toHaveBeenCalled();
      expect(events.emitToTrip).toHaveBeenCalledWith(
        TRIP_ID,
        'trip:activity',
        expect.objectContaining({
          action: 'suggestion_created',
          actor_id: USER_ID,
        }),
      );
    });
  });

  describe('list', () => {
    it('404s non-members without leaking trip existence', async () => {
      memberRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.list(USER_ID, TRIP_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(activityRepo.find).not.toHaveBeenCalled();
    });

    it('enforces membership and clamps the limit to the allowed range', async () => {
      memberRepo.findOne.mockResolvedValueOnce({
        trip_id: TRIP_ID,
        user_id: USER_ID,
      } as TripMember);
      activityRepo.find.mockResolvedValueOnce([
        {
          id: 'a-1',
          trip_id: TRIP_ID,
          actor_id: USER_ID,
          action: 'member_joined',
          payload: { role: 'member' },
          created_at: new Date('2026-04-24T10:00:00Z'),
          actor: { display_name: 'Adam' },
        } as unknown as TripActivity,
      ]);

      const result = await service.list(USER_ID, TRIP_ID, 10_000);

      expect(activityRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { trip_id: TRIP_ID },
          take: 200, // clamped to MAX_ACTIVITY_LIMIT
          order: { created_at: 'DESC' },
        }),
      );
      expect(result.activity[0]).toMatchObject({
        action: 'member_joined',
        actor_name: 'Adam',
      });
    });
  });
});
