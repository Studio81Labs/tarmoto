/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/unbound-method */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { TripsService } from './trips.service.js';
import { Trip } from '../../entities/trip.entity.js';
import { TripMember } from '../../entities/trip-member.entity.js';
import { EventsGateway } from '../events/events.gateway.js';
import { TripActivityService } from '../trip-activity/trip-activity.service.js';

const OWNER_ID = '00000000-0000-0000-0000-000000000001';
const OTHER_ID = '00000000-0000-0000-0000-000000000002';
const TRIP_ID = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-04-24T10:00:00Z');

function makeOwnedTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    id: TRIP_ID,
    owner_id: OWNER_ID,
    title: 'Big Italian Loop',
    region: 'Dolomites',
    num_days: 5,
    daily_km_min: 150,
    daily_km_max: 350,
    min_quality: 3.0,
    road_preference: 'curvy',
    status: 'draft',
    invite_code: 'ABCDEFGH',
    created_at: NOW,
    updated_at: NOW,
    members: [
      {
        id: 'm-1',
        trip_id: TRIP_ID,
        user_id: OWNER_ID,
        role: 'owner',
        joined_at: NOW,
        user: { display_name: 'Adam' },
      } as unknown as TripMember,
    ],
    days: [],
    ...overrides,
  } as unknown as Trip;
}

function makeJoinedTrip(): Trip {
  // The post-join `getDetail` reload must include the joining user's
  // membership row, otherwise the SQL-level membership filter would
  // 404 the very response we just earned by joining.
  return makeOwnedTrip({
    members: [
      {
        user_id: OWNER_ID,
        role: 'owner',
        joined_at: NOW,
        user: { display_name: 'Adam' },
      } as unknown as TripMember,
      {
        user_id: OTHER_ID,
        role: 'member',
        joined_at: NOW,
        user: { display_name: 'Eve' },
      } as unknown as TripMember,
    ],
  });
}

type QbMock = {
  innerJoin: jest.Mock;
  leftJoinAndSelect: jest.Mock;
  loadRelationCountAndMap: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  orderBy: jest.Mock;
  addOrderBy: jest.Mock;
  getMany: jest.Mock;
  getOne: jest.Mock;
};

function makeQbMock(
  returns: { getMany?: Trip[]; getOne?: Trip | null } = {},
): QbMock {
  const qb = {} as QbMock;
  const chainables = [
    'innerJoin',
    'leftJoinAndSelect',
    'loadRelationCountAndMap',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
  ] as const;
  for (const m of chainables) {
    (qb as Record<string, jest.Mock>)[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getMany = jest.fn().mockResolvedValue(returns.getMany ?? []);
  qb.getOne = jest.fn().mockResolvedValue(returns.getOne ?? null);
  return qb;
}

describe('TripsService', () => {
  let service: TripsService;
  let tripRepo: jest.Mocked<Repository<Trip>>;
  let memberRepo: jest.Mocked<Repository<TripMember>>;
  let manager: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
  };
  // Pulled out alongside `manager` so tests can call `mockImplementation`
  // / `mockRejectedValue` on a properly-typed `jest.Mock` without lint
  // tripping on the deeply-nested mock cast on `tripRepo.manager.*`.
  let transactionMock: jest.Mock;
  let events: jest.Mocked<Pick<EventsGateway, 'emitToTrip'>>;
  let activity: jest.Mocked<Pick<TripActivityService, 'recordSafe'>>;

  beforeEach(async () => {
    // The transactional `create` flow calls `tripRepo.manager.transaction`
    // and operates through that manager. Mock it as a callable that
    // immediately invokes the callback with a manager that mirrors the
    // repo create/save semantics.
    manager = {
      create: jest
        .fn()
        .mockImplementation(
          (_entity: unknown, data: Record<string, unknown>) => ({ ...data }),
        ),
      save: jest.fn().mockImplementation((entity: { id?: string }) =>
        Promise.resolve({
          ...entity,
          id: entity.id ?? TRIP_ID,
          created_at: NOW,
          updated_at: NOW,
          joined_at: NOW,
        }),
      ),
      findOne: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    transactionMock = jest
      .fn()
      .mockImplementation(async (cb: (m: typeof manager) => Promise<unknown>) =>
        cb(manager),
      );

    tripRepo = {
      manager: { transaction: transactionMock },
      create: jest.fn().mockImplementation((data: Partial<Trip>) => ({
        ...data,
      })),
      save: jest.fn().mockImplementation((entity: Trip) =>
        Promise.resolve({
          ...entity,
          id: entity.id ?? TRIP_ID,
          created_at: NOW,
          updated_at: NOW,
        }),
      ),
      findOne: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn().mockReturnValue(makeQbMock()),
    } as unknown as jest.Mocked<Repository<Trip>>;

    memberRepo = {
      create: jest.fn().mockImplementation((data: Partial<TripMember>) => ({
        ...data,
      })),
      save: jest
        .fn()
        .mockImplementation((entity: TripMember) =>
          Promise.resolve({ ...entity, id: 'm-new', joined_at: NOW }),
        ),
      findOne: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<Repository<TripMember>>;

    events = { emitToTrip: jest.fn() };
    activity = { recordSafe: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TripsService,
        { provide: getRepositoryToken(Trip), useValue: tripRepo },
        { provide: getRepositoryToken(TripMember), useValue: memberRepo },
        { provide: EventsGateway, useValue: events },
        { provide: TripActivityService, useValue: activity },
      ],
    }).compile();

    service = module.get(TripsService);
  });

  /** Wire `createQueryBuilder` to return a fresh QB whose `getOne` resolves to `trip`. */
  function mockGetDetailReturns(trip: Trip | null): QbMock {
    const qb = makeQbMock({ getOne: trip });
    tripRepo.createQueryBuilder.mockReturnValue(qb as never);
    return qb;
  }

  /** Wire `createQueryBuilder` to return a fresh QB whose `getMany` resolves to `trips`. */
  function mockListReturns(trips: Trip[]): QbMock {
    const qb = makeQbMock({ getMany: trips });
    tripRepo.createQueryBuilder.mockReturnValue(qb as never);
    return qb;
  }

  describe('create', () => {
    it('persists trip + owner membership and returns the detail with an invite code', async () => {
      mockGetDetailReturns(makeOwnedTrip()); // post-save reload

      const result = await service.create(OWNER_ID, {
        title: 'Big Italian Loop',
        num_days: 5,
        region: 'Dolomites',
      });

      // Trip + owner-membership writes both go through the transactional
      // manager, not the per-entity repos.
      expect(transactionMock).toHaveBeenCalledTimes(1);
      expect(manager.create).toHaveBeenCalledWith(
        Trip,
        expect.objectContaining({
          owner_id: OWNER_ID,
          title: 'Big Italian Loop',
          num_days: 5,
          region: 'Dolomites',
          status: 'draft',
          invite_code: expect.stringMatching(/^[A-Z2-9]{8}$/),
        }),
      );
      expect(manager.create).toHaveBeenCalledWith(
        TripMember,
        expect.objectContaining({
          trip_id: TRIP_ID,
          user_id: OWNER_ID,
          role: 'owner',
        }),
      );
      expect(result.invite_code).toMatch(/^[A-Z2-9]{8}$/);
      expect(result.members).toHaveLength(1);
      expect(result.members[0]).toMatchObject({
        user_id: OWNER_ID,
        role: 'owner',
        display_name: 'Adam',
      });
      expect(result.days).toEqual([]);
    });

    it('rejects daily_km_min > daily_km_max when both are provided', async () => {
      await expect(
        service.create(OWNER_ID, {
          title: 'Bad ranges',
          num_days: 3,
          daily_km_min: 400,
          daily_km_max: 200,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(transactionMock).not.toHaveBeenCalled();
    });

    it('rejects partial input where daily_km_min exceeds the default daily_km_max', async () => {
      // Defaults: min=150, max=350. Passing min=500 alone means the
      // effective row would be (500, 350) — invalid.
      await expect(
        service.create(OWNER_ID, {
          title: 'Half-specified',
          num_days: 3,
          daily_km_min: 500,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(transactionMock).not.toHaveBeenCalled();
    });

    it('rejects partial input where the default daily_km_min exceeds the supplied daily_km_max', async () => {
      // Mirror case: default min=150 vs supplied max=50.
      await expect(
        service.create(OWNER_ID, {
          title: 'Half-specified',
          num_days: 3,
          daily_km_max: 50,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(transactionMock).not.toHaveBeenCalled();
    });

    it('rolls back the trip insert when the owner-membership insert fails', async () => {
      manager.save
        .mockResolvedValueOnce({ id: TRIP_ID }) // trip insert
        .mockRejectedValueOnce(new Error('membership insert exploded'));

      await expect(
        service.create(OWNER_ID, { title: 'Atomic', num_days: 2 }),
      ).rejects.toThrow('membership insert exploded');
      // The post-save `getDetail` reload should never have run — its QB
      // factory wasn't touched.
      expect(tripRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('retries the whole transaction with a fresh code on invite_code unique violation', async () => {
      // Simulate a TOCTOU race: the first transaction's trip insert
      // hits the `idx_trips_invite_code` unique constraint. The retry
      // loop must catch only that specific violation and rerun the
      // transaction with a freshly generated code.
      const inviteCodeError = Object.assign(
        new Error('duplicate invite_code'),
        {
          code: '23505',
          constraint: 'idx_trips_invite_code',
        },
      );
      let txnCount = 0;
      transactionMock.mockImplementation(
        async (cb: (m: typeof manager) => Promise<unknown>) => {
          txnCount += 1;
          if (txnCount === 1) throw inviteCodeError;
          return cb(manager);
        },
      );
      mockGetDetailReturns(makeOwnedTrip());

      const result = await service.create(OWNER_ID, {
        title: 'Race-safe',
        num_days: 2,
      });

      expect(txnCount).toBe(2);
      expect(result.invite_code).toMatch(/^[A-Z2-9]{8}$/);
    });

    it('does NOT retry when a 23505 comes from a different constraint', async () => {
      // A unique violation on, say, the trip_members (trip_id, user_id)
      // index isn't a code collision — it would mean a real bug. Don't
      // mask it by retrying with a fresh code.
      const memberError = Object.assign(new Error('duplicate membership'), {
        code: '23505',
        constraint: 'trip_members_trip_id_user_id_unique',
      });
      transactionMock.mockRejectedValueOnce(memberError);

      await expect(
        service.create(OWNER_ID, { title: 't', num_days: 2 }),
      ).rejects.toBe(memberError);
      // Single attempt, no retry.
      expect(transactionMock).toHaveBeenCalledTimes(1);
    });

    it('gives up after MAX_INVITE_ALLOCATION_ATTEMPTS persistent collisions', async () => {
      const inviteCodeError = Object.assign(
        new Error('duplicate invite_code'),
        {
          code: '23505',
          constraint: 'idx_trips_invite_code',
        },
      );
      transactionMock.mockRejectedValue(inviteCodeError);

      await expect(
        service.create(OWNER_ID, { title: 't', num_days: 2 }),
      ).rejects.toThrow(/Failed to allocate a unique trip invite code/);
      expect(transactionMock).toHaveBeenCalledTimes(5);
    });
  });

  describe('list', () => {
    it('returns a summary per visible trip, ordered newest-first', async () => {
      const trips = [
        makeOwnedTrip({ id: 't-1', title: 'A', created_at: NOW }),
        makeOwnedTrip({
          id: 't-2',
          title: 'B',
          created_at: new Date('2026-04-23T10:00:00Z'),
        }),
      ];
      // The COUNT mapping is what `list` uses now; simulate the mapping
      // by stamping `member_count` directly on the trip rows.
      trips.forEach((t) => {
        t.member_count = 1;
      });
      const qb = mockListReturns(trips);

      const result = await service.list(OWNER_ID, {});

      // Membership filter is enforced at the SQL level via inner join.
      expect(qb.innerJoin).toHaveBeenCalledWith(
        TripMember,
        'm',
        'm.trip_id = trip.id AND m.user_id = :userId',
        { userId: OWNER_ID },
      );
      // Member count is loaded via COUNT mapping, not by hydrating each
      // member row — this is the fix for the P2 perf finding.
      expect(qb.loadRelationCountAndMap).toHaveBeenCalledWith(
        'trip.member_count',
        'trip.members',
      );
      expect(qb.leftJoinAndSelect).not.toHaveBeenCalled();
      expect(qb.andWhere).not.toHaveBeenCalled();
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        id: 't-1',
        title: 'A',
        member_count: 1,
      });
    });

    it('applies the optional status filter', async () => {
      const qb = mockListReturns([]);

      await service.list(OWNER_ID, { status: 'planned' });

      expect(qb.andWhere).toHaveBeenCalledWith('trip.status = :status', {
        status: 'planned',
      });
    });
  });

  describe('getDetail', () => {
    it('returns the detail for a member', async () => {
      const qb = mockGetDetailReturns(makeOwnedTrip());

      const result = await service.getDetail(OWNER_ID, TRIP_ID);

      expect(result.id).toBe(TRIP_ID);
      expect(result.invite_code).toBe('ABCDEFGH');
      // Membership predicate is in the SQL, so non-members would never
      // have hydrated the deep relations to begin with.
      expect(qb.innerJoin).toHaveBeenCalledWith(
        TripMember,
        'caller',
        'caller.trip_id = trip.id AND caller.user_id = :userId',
        { userId: OWNER_ID },
      );
    });

    it('404s when the SQL-level membership filter excludes the caller', async () => {
      // `getOne` returning null mirrors the production behaviour: the
      // inner join finds no caller-membership row, so no trip row is
      // produced — non-member and missing-trip collapse into the same
      // 404 without leaking existence.
      mockGetDetailReturns(null);

      await expect(service.getDetail(OTHER_ID, TRIP_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('join', () => {
    it('adds a member when the code matches', async () => {
      tripRepo.findOne.mockResolvedValueOnce(makeOwnedTrip()); // join lookup
      memberRepo.findOne.mockResolvedValueOnce(null);
      mockGetDetailReturns(makeJoinedTrip()); // post-join detail

      const result = await service.join(OTHER_ID, TRIP_ID, 'abcdefgh');

      expect(memberRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          trip_id: TRIP_ID,
          user_id: OTHER_ID,
          role: 'member',
        }),
      );
      expect(result.members).toHaveLength(2);
    });

    it('normalizes the invite code (case + whitespace)', async () => {
      tripRepo.findOne.mockResolvedValueOnce(
        makeOwnedTrip({ invite_code: 'ABCDEFGH' }),
      );
      memberRepo.findOne.mockResolvedValueOnce(null);
      mockGetDetailReturns(makeJoinedTrip());

      await expect(
        service.join(OTHER_ID, TRIP_ID, '  abcdefgh  '),
      ).resolves.toBeDefined();
    });

    it('is idempotent for an existing member', async () => {
      tripRepo.findOne.mockResolvedValueOnce(makeOwnedTrip());
      memberRepo.findOne.mockResolvedValueOnce({
        user_id: OWNER_ID,
      } as TripMember);
      mockGetDetailReturns(makeOwnedTrip());

      await service.join(OWNER_ID, TRIP_ID, 'ABCDEFGH');

      expect(memberRepo.save).not.toHaveBeenCalled();
    });

    it('forbids joins with a wrong code', async () => {
      tripRepo.findOne.mockResolvedValueOnce(
        makeOwnedTrip({ invite_code: 'CORRECT1' }),
      );

      await expect(
        service.join(OTHER_ID, TRIP_ID, 'WRONG123'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(memberRepo.save).not.toHaveBeenCalled();
    });

    it('forbids joins for a missing trip without leaking existence', async () => {
      tripRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.join(OTHER_ID, TRIP_ID, 'ABCDEFGH'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('swallows a unique-violation race on duplicate insert', async () => {
      tripRepo.findOne.mockResolvedValueOnce(makeOwnedTrip());
      memberRepo.findOne.mockResolvedValueOnce(null);
      memberRepo.save.mockRejectedValueOnce(
        Object.assign(new Error('duplicate key'), { code: '23505' }),
      );
      mockGetDetailReturns(makeJoinedTrip());

      await expect(
        service.join(OTHER_ID, TRIP_ID, 'ABCDEFGH'),
      ).resolves.toBeDefined();
    });

    it('rethrows non-unique-violation errors', async () => {
      tripRepo.findOne.mockResolvedValueOnce(makeOwnedTrip());
      memberRepo.findOne.mockResolvedValueOnce(null);
      memberRepo.save.mockRejectedValueOnce(
        Object.assign(new Error('boom'), { code: '99999' }),
      );

      await expect(service.join(OTHER_ID, TRIP_ID, 'ABCDEFGH')).rejects.toThrow(
        'boom',
      );
    });
  });

  describe('update', () => {
    it('applies partial updates, fires trip:updated, and returns the detail', async () => {
      memberRepo.findOne.mockResolvedValueOnce({
        role: 'owner',
      } as TripMember);
      manager.findOne.mockResolvedValueOnce(makeOwnedTrip());
      mockGetDetailReturns(makeOwnedTrip({ title: 'Renamed' }));

      const result = await service.update(OWNER_ID, TRIP_ID, {
        title: 'Renamed',
      });

      // The write runs inside the transactional manager so the
      // pre-image read and the UPDATE are serialised on the row lock.
      expect(manager.update).toHaveBeenCalledWith(
        Trip,
        { id: TRIP_ID },
        expect.objectContaining({ title: 'Renamed' }),
      );
      expect(events.emitToTrip).toHaveBeenCalledWith(
        TRIP_ID,
        'trip:updated',
        expect.objectContaining({ id: TRIP_ID }),
      );
      expect(result.title).toBe('Renamed');
    });

    it('404s a non-member instead of leaking field-level validation', async () => {
      memberRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.update(OTHER_ID, TRIP_ID, { title: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(manager.update).not.toHaveBeenCalled();
      expect(transactionMock).not.toHaveBeenCalled();
    });

    it('404s a plain member who is not owner/admin', async () => {
      memberRepo.findOne.mockResolvedValueOnce({
        role: 'member',
      } as TripMember);

      await expect(
        service.update(OTHER_ID, TRIP_ID, { title: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('rejects a partial patch that lands an invalid (min > max) pairing', async () => {
      memberRepo.findOne.mockResolvedValueOnce({
        role: 'owner',
      } as TripMember);
      manager.findOne.mockResolvedValueOnce(makeOwnedTrip()); // current 150/350

      await expect(
        service.update(OWNER_ID, TRIP_ID, { daily_km_min: 500 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('allows admins to mutate trip metadata', async () => {
      memberRepo.findOne.mockResolvedValueOnce({
        role: 'admin',
      } as TripMember);
      manager.findOne.mockResolvedValueOnce(makeOwnedTrip());
      mockGetDetailReturns(makeOwnedTrip({ status: 'planned' }));

      await service.update(OTHER_ID, TRIP_ID, { status: 'planned' });

      expect(manager.update).toHaveBeenCalled();
    });

    it('reads the pre-image with a pessimistic row lock to close the min/max race', async () => {
      memberRepo.findOne.mockResolvedValueOnce({
        role: 'owner',
      } as TripMember);
      manager.findOne.mockResolvedValueOnce(makeOwnedTrip());
      mockGetDetailReturns(makeOwnedTrip({ title: 'Renamed' }));

      await service.update(OWNER_ID, TRIP_ID, { title: 'Renamed' });

      // The lock mode must be pessimistic_write so a concurrent PATCH
      // blocks and re-reads the post-commit state, catching partial-
      // patch races that would otherwise leave min > max.
      expect(manager.findOne).toHaveBeenCalledWith(
        Trip,
        expect.objectContaining({
          lock: { mode: 'pessimistic_write' },
        }),
      );
    });

    it('writes ONLY the supplied delta — untouched fields are not clobbered by concurrent PATCHes', async () => {
      // Without this guarantee, two privileged members PATCHing
      // different fields concurrently would each read the same pre-image
      // and each rewrite the untouched fields to their read-time values,
      // so the loser of the race would lose their co-planner's change.
      memberRepo.findOne.mockResolvedValueOnce({
        role: 'owner',
      } as TripMember);
      manager.findOne.mockResolvedValueOnce(makeOwnedTrip());
      mockGetDetailReturns(makeOwnedTrip({ title: 'Renamed' }));

      await service.update(OWNER_ID, TRIP_ID, { title: 'Renamed' });

      expect(manager.update).toHaveBeenCalledWith(
        Trip,
        { id: TRIP_ID },
        { title: 'Renamed' },
      );
      // Crucially: region, num_days, status, etc. are NOT present.
      const [, , delta] = manager.update.mock.calls[0];
      expect(Object.keys(delta as object)).toEqual(['title']);
    });

    it('skips the UPDATE + trip:updated emit entirely when the DTO carries no fields', async () => {
      // No-op PATCH shouldn't rattle every subscribed member's UI.
      memberRepo.findOne.mockResolvedValueOnce({
        role: 'owner',
      } as TripMember);
      tripRepo.findOne.mockResolvedValueOnce(
        makeOwnedTrip() as unknown as Trip,
      ); // empty-PATCH existence probe
      mockGetDetailReturns(makeOwnedTrip());

      await service.update(OWNER_ID, TRIP_ID, {});

      expect(manager.update).not.toHaveBeenCalled();
      expect(transactionMock).not.toHaveBeenCalled();
      expect(events.emitToTrip).not.toHaveBeenCalled();
    });

    it('validates min/max against locked row when only one side is supplied', async () => {
      // Pre-patch: (150, 350). Supply only min=500 → effective max is
      // still 350 from the locked row, so the pair is invalid.
      memberRepo.findOne.mockResolvedValueOnce({
        role: 'owner',
      } as TripMember);
      manager.findOne.mockResolvedValueOnce(makeOwnedTrip());

      await expect(
        service.update(OWNER_ID, TRIP_ID, { daily_km_min: 500 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(manager.update).not.toHaveBeenCalled();
    });
  });

  describe('detail mapping', () => {
    it('converts route_geom + waypoint locations to lat/lng', async () => {
      const trip = makeOwnedTrip({
        days: [
          {
            id: 'd-1',
            day_number: 1,
            title: 'Day 1',
            distance_km: 220.5,
            avg_quality: 4.2,
            elevation_gain: 1500,
            estimated_time: '04:30:00',
            route_geom: {
              type: 'LineString',
              coordinates: [
                [11.34, 46.49],
                [11.36, 46.51],
              ],
            },
            waypoints: [
              {
                id: 'w-1',
                sequence: 1,
                location: { type: 'Point', coordinates: [11.34, 46.49] },
                name: 'Start',
                waypoint_type: 'start',
                road_segment_id: null,
                notes: null,
                duration_min: null,
              },
            ],
          } as never,
        ],
      });
      mockGetDetailReturns(trip);

      const result = await service.getDetail(OWNER_ID, TRIP_ID);

      expect(result.days[0]).toMatchObject({
        day_number: 1,
        distance_km: 220.5,
        estimated_time_min: 270,
        route_geometry: [
          { lat: 46.49, lng: 11.34 },
          { lat: 46.51, lng: 11.36 },
        ],
      });
      expect(result.days[0]?.waypoints[0]).toMatchObject({
        sequence: 1,
        lat: 46.49,
        lng: 11.34,
        waypoint_type: 'start',
      });
    });

    it('parses pg interval objects into minutes', async () => {
      const trip = makeOwnedTrip({
        days: [
          {
            id: 'd-1',
            day_number: 1,
            title: null,
            distance_km: 0,
            avg_quality: 0,
            elevation_gain: 0,
            estimated_time: { hours: 2, minutes: 15, seconds: 0 },
            route_geom: null,
            waypoints: [],
          } as never,
        ],
      });
      mockGetDetailReturns(trip);

      const result = await service.getDetail(OWNER_ID, TRIP_ID);
      expect(result.days[0]?.estimated_time_min).toBe(135);
    });
  });
});
