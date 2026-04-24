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
  };

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
    };

    tripRepo = {
      manager: {
        transaction: jest
          .fn()
          .mockImplementation(
            async (cb: (m: typeof manager) => Promise<unknown>) => cb(manager),
          ),
      },
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TripsService,
        { provide: getRepositoryToken(Trip), useValue: tripRepo },
        { provide: getRepositoryToken(TripMember), useValue: memberRepo },
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
      tripRepo.findOne.mockResolvedValueOnce(null); // invite collision check
      mockGetDetailReturns(makeOwnedTrip()); // post-save reload

      const result = await service.create(OWNER_ID, {
        title: 'Big Italian Loop',
        num_days: 5,
        region: 'Dolomites',
      });

      // Trip + owner-membership writes both go through the transactional
      // manager, not the per-entity repos.
      expect(tripRepo.manager.transaction).toHaveBeenCalledTimes(1);
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
      expect(tripRepo.manager.transaction).not.toHaveBeenCalled();
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
      expect(tripRepo.manager.transaction).not.toHaveBeenCalled();
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
      expect(tripRepo.manager.transaction).not.toHaveBeenCalled();
    });

    it('rolls back the trip insert when the owner-membership insert fails', async () => {
      tripRepo.findOne.mockResolvedValueOnce(null); // invite collision check
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

    it('retries invite-code allocation on collision', async () => {
      const collidedTrip = { id: 'other' } as Trip;
      tripRepo.findOne
        .mockResolvedValueOnce(collidedTrip) // first candidate collides
        .mockResolvedValueOnce(null); // second succeeds
      mockGetDetailReturns(makeOwnedTrip());

      const result = await service.create(OWNER_ID, {
        title: 't',
        num_days: 2,
      });

      expect(result.invite_code).toMatch(/^[A-Z2-9]{8}$/);
      // Two collision lookups — getDetail uses the QB now, not findOne.
      expect(tripRepo.findOne).toHaveBeenCalledTimes(2);
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
