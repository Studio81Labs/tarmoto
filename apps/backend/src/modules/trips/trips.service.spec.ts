/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/unbound-method */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { TripsService } from './trips.service.js';
import { Trip } from '../../entities/trip.entity.js';
import { TripDay } from '../../entities/trip-day.entity.js';
import { TripMember } from '../../entities/trip-member.entity.js';
import { TripSuggestion } from '../../entities/trip-suggestion.entity.js';
import { TripShare } from '../../entities/trip-share.entity.js';
import { User } from '../../entities/user.entity.js';
import { EmailService } from '../email/email.service.js';
import { EventsGateway } from '../events/events.gateway.js';
import { TripActivityService } from '../trip-activity/trip-activity.service.js';
import { TripSharesService } from '../trip-shares/trip-shares.service.js';

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
    delete: jest.Mock;
  };
  // Pulled out alongside `manager` so tests can call `mockImplementation`
  // / `mockRejectedValue` on a properly-typed `jest.Mock` without lint
  // tripping on the deeply-nested mock cast on `tripRepo.manager.*`.
  let transactionMock: jest.Mock;
  let userRepo: jest.Mocked<Repository<User>>;
  let events: jest.Mocked<Pick<EventsGateway, 'emitToTrip'>>;
  let activity: jest.Mocked<Pick<TripActivityService, 'recordSafe'>>;
  let tripShares: jest.Mocked<Pick<TripSharesService, 'findActiveByToken'>>;
  let email: jest.Mocked<Pick<EmailService, 'sendTripInvite'>>;
  let config: jest.Mocked<Pick<ConfigService, 'get'>>;

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
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
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

    userRepo = {
      findOne: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<Repository<User>>;

    events = { emitToTrip: jest.fn() };
    activity = { recordSafe: jest.fn().mockResolvedValue(undefined) };
    tripShares = { findActiveByToken: jest.fn() };
    email = { sendTripInvite: jest.fn().mockResolvedValue(null) };
    config = {
      get: jest.fn((key: string) =>
        key === 'TARMOTO_COMPANION_URL'
          ? 'https://app.tarmoto.test'
          : undefined,
      ),
    } as unknown as jest.Mocked<Pick<ConfigService, 'get'>>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TripsService,
        { provide: getRepositoryToken(Trip), useValue: tripRepo },
        { provide: getRepositoryToken(TripMember), useValue: memberRepo },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: EventsGateway, useValue: events },
        { provide: TripActivityService, useValue: activity },
        { provide: TripSharesService, useValue: tripShares },
        { provide: EmailService, useValue: email },
        { provide: ConfigService, useValue: config },
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

  describe('importFromRoute', () => {
    const ROUTE_DTO = {
      title: 'Stelvio loop',
      source_format: 'gpx' as const,
      geometry: [
        { lat: 46.47, lng: 10.37 },
        { lat: 46.5, lng: 10.41 },
        { lat: 46.54, lng: 10.47 },
        { lat: 46.61, lng: 10.57 },
      ],
      waypoints: [
        { lat: 46.47, lng: 10.37, name: 'Bormio' },
        { lat: 46.54, lng: 10.47, name: 'Umbrail pass' },
        { lat: 46.61, lng: 10.57, name: 'Prato' },
      ],
    };

    it('creates a planned 1-day trip with the imported geometry and waypoints', async () => {
      mockGetDetailReturns(makeOwnedTrip({ status: 'planned' }));

      const result = await service.importFromRoute(OWNER_ID, ROUTE_DTO);

      expect(transactionMock).toHaveBeenCalledTimes(1);
      // Trip row: planned + 1 day + invite code allocated.
      expect(manager.create).toHaveBeenCalledWith(
        Trip,
        expect.objectContaining({
          owner_id: OWNER_ID,
          title: 'Stelvio loop',
          num_days: 1,
          status: 'planned',
          invite_code: expect.stringMatching(/^[A-Z2-9]{8}$/),
        }),
      );
      // Owner membership row.
      expect(manager.create).toHaveBeenCalledWith(
        TripMember,
        expect.objectContaining({
          trip_id: TRIP_ID,
          user_id: OWNER_ID,
          role: 'owner',
        }),
      );
      // The day's route geometry is persisted as a LineString of [lng,lat]
      // tuples — order matches the DTO and the column SRID expectation.
      const dayCall = manager.create.mock.calls.find(
        ([entity]: [unknown, ...unknown[]]) =>
          (entity as { name?: string })?.name === 'TripDay' ||
          // some test setups stringify the entity ref — fall back to body
          // shape detection so this assertion stays robust to either form.
          (
            (entity as { toString?: () => string })?.toString?.() ?? ''
          ).includes('TripDay'),
      );
      // We also verify the body-shape branch in case `manager.create`
      // was called with the entity class symbol our matcher above can't
      // identify. The assertion below is the durable one.
      const dayBodies = manager.create.mock.calls
        .map(([, body]) => body as Record<string, unknown>)
        .filter(
          (b) =>
            'route_geom' in b &&
            (b.route_geom as { type: string }).type === 'LineString',
        );
      expect(dayBodies).toHaveLength(1);
      expect(dayBodies[0]).toMatchObject({
        day_number: 1,
        title: 'Stelvio loop',
      });
      const coords = (dayBodies[0].route_geom as { coordinates: number[][] })
        .coordinates;
      expect(coords[0]).toEqual([10.37, 46.47]);
      expect(coords[coords.length - 1]).toEqual([10.57, 46.61]);
      expect(dayCall ?? dayBodies[0]).toBeDefined();

      // Waypoints: start, single via, end (Bormio/Prato are deduped
      // because they coincide with the polyline endpoints).
      const waypointBodies = manager.create.mock.calls
        .map(([, body]) => body as Record<string, unknown>)
        .filter((b) => 'waypoint_type' in b);
      expect(waypointBodies).toHaveLength(3);
      expect(waypointBodies[0]).toMatchObject({
        sequence: 0,
        waypoint_type: 'start',
        name: 'Bormio',
      });
      expect(waypointBodies[1]).toMatchObject({
        sequence: 1,
        waypoint_type: 'via',
        name: 'Umbrail pass',
      });
      expect(waypointBodies[2]).toMatchObject({
        sequence: 2,
        waypoint_type: 'end',
        name: 'Prato',
      });

      expect(result.status).toBe('planned');
    });

    it('produces a single start→end pair when the file has no explicit waypoints', async () => {
      mockGetDetailReturns(makeOwnedTrip({ status: 'planned' }));
      await service.importFromRoute(OWNER_ID, {
        ...ROUTE_DTO,
        waypoints: undefined,
      });
      const waypointBodies = manager.create.mock.calls
        .map(([, body]) => body as Record<string, unknown>)
        .filter((b) => 'waypoint_type' in b);
      expect(waypointBodies).toHaveLength(2);
      expect(waypointBodies[0]).toMatchObject({
        sequence: 0,
        waypoint_type: 'start',
      });
      expect(waypointBodies[1]).toMatchObject({
        sequence: 1,
        waypoint_type: 'end',
      });
      // Sequences must be 0..n-1 with no gaps so the per-day index stays
      // well-formed for downstream consumers.
      expect(waypointBodies[0]).not.toHaveProperty('name', expect.anything());
    });

    it('retries the whole transaction on invite_code unique violation', async () => {
      mockGetDetailReturns(makeOwnedTrip({ status: 'planned' }));
      const inviteCodeError = Object.assign(
        new Error('duplicate invite_code'),
        {
          code: '23505',
          constraint: 'idx_trips_invite_code',
        },
      );
      transactionMock
        .mockRejectedValueOnce(inviteCodeError)
        .mockImplementationOnce(
          async (cb: (m: typeof manager) => Promise<unknown>) => cb(manager),
        );

      const result = await service.importFromRoute(OWNER_ID, ROUTE_DTO);
      expect(transactionMock).toHaveBeenCalledTimes(2);
      expect(result.status).toBe('planned');
    });

    it('honours the per-waypoint `type` field when supplied', async () => {
      // The DTO accepts `via | fuel | rest | photo` — clients that have
      // richer waypoint info (a future planner-aware import flow) can
      // mark fuel stops or photo waypoints. Earlier code dropped the
      // type and forced every via to `via`.
      mockGetDetailReturns(makeOwnedTrip({ status: 'planned' }));
      await service.importFromRoute(OWNER_ID, {
        ...ROUTE_DTO,
        waypoints: [
          { lat: 46.47, lng: 10.37, name: 'Bormio' },
          {
            lat: 46.5,
            lng: 10.41,
            name: 'Filling station',
            type: 'fuel',
          },
          {
            lat: 46.54,
            lng: 10.47,
            name: 'Lookout',
            type: 'photo',
          },
          { lat: 46.61, lng: 10.57, name: 'Prato' },
        ],
      });
      const waypointBodies = manager.create.mock.calls
        .map(([, body]) => body as Record<string, unknown>)
        .filter((b) => 'waypoint_type' in b);
      // start (Bormio) + 2 vias (fuel, photo) + end (Prato).
      expect(waypointBodies).toHaveLength(4);
      expect(waypointBodies[0]).toMatchObject({
        waypoint_type: 'start',
        name: 'Bormio',
      });
      expect(waypointBodies[1]).toMatchObject({
        waypoint_type: 'fuel',
        name: 'Filling station',
      });
      expect(waypointBodies[2]).toMatchObject({
        waypoint_type: 'photo',
        name: 'Lookout',
      });
      expect(waypointBodies[3]).toMatchObject({
        waypoint_type: 'end',
        name: 'Prato',
      });
    });

    it('replaces an existing server trip with imported geometry without creating a duplicate trip', async () => {
      memberRepo.findOne.mockResolvedValueOnce({
        trip_id: TRIP_ID,
        user_id: OWNER_ID,
        role: 'owner',
      } as TripMember);
      manager.findOne.mockResolvedValueOnce(
        makeOwnedTrip({ id: TRIP_ID, daily_km_min: 150, daily_km_max: 350 }),
      );
      mockGetDetailReturns(makeOwnedTrip({ id: TRIP_ID, status: 'planned' }));

      await service.replaceWithImportedRoute(OWNER_ID, TRIP_ID, ROUTE_DTO);

      expect(transactionMock).toHaveBeenCalledTimes(1);
      expect(manager.findOne).toHaveBeenCalledWith(
        Trip,
        expect.objectContaining({
          where: { id: TRIP_ID },
          lock: { mode: 'pessimistic_write' },
        }),
      );
      expect(manager.update).toHaveBeenCalledWith(
        Trip,
        { id: TRIP_ID },
        expect.objectContaining({
          title: 'Stelvio loop',
          num_days: 1,
          status: 'planned',
        }),
      );
      expect(manager.update).toHaveBeenCalledWith(
        TripSuggestion,
        { trip_id: TRIP_ID },
        { trip_day_id: null },
      );
      expect(manager.delete).toHaveBeenCalledWith(TripDay, {
        trip_id: TRIP_ID,
      });
      expect(manager.create).not.toHaveBeenCalledWith(
        TripMember,
        expect.anything(),
      );
      expect(manager.create).not.toHaveBeenCalledWith(Trip, expect.anything());
      expect(activity.recordSafe).toHaveBeenCalledWith(
        TRIP_ID,
        OWNER_ID,
        'trip_updated',
        expect.objectContaining({ fields: ['imported_route'] }),
      );
    });
  });

  describe('importFromShare', () => {
    /**
     * Build a snapshot in the companion's `Trip` shape with N days. Each
     * day gets a 4-point geometry, an explicit distance, and a small
     * waypoint list covering the full type vocabulary so we can assert
     * `accommodation` (which the legacy flat-import path drops) survives
     * the round-trip.
     */
    function makeShare(
      days: Array<{
        title?: string;
        distanceKm?: number;
        durationMinutes?: number;
        avgQuality?: number;
        elevationGain?: number;
        coordinates?: Array<[number, number]>;
        waypoints?: Array<{
          lat: number;
          lng: number;
          name?: string;
          type?: string;
        }>;
      }>,
    ): TripShare {
      return {
        id: 'share-1',
        owner_id: 'owner-x',
        share_token: 'tok-deadbeef',
        title: 'Alps loop — 3 days',
        view_count: 7,
        created_at: NOW,
        updated_at: NOW,
        snapshot: {
          name: 'Alps loop snapshot',
          days: days.map((d, i) => ({
            dayNumber: i + 1,
            title: d.title ?? `Day ${i + 1}`,
            distanceKm: d.distanceKm ?? 100,
            durationMinutes: d.durationMinutes ?? 180,
            avgQuality: d.avgQuality ?? 3.8,
            elevationGain: d.elevationGain ?? 800,
            routeGeometry: d.coordinates
              ? { type: 'LineString', coordinates: d.coordinates }
              : undefined,
            waypoints: (d.waypoints ?? []).map((w, idx) => ({
              id: `wp-${i}-${idx}`,
              location: { lat: w.lat, lng: w.lng },
              name: w.name,
              type: w.type ?? 'via',
            })),
          })),
        },
        owner: { display_name: 'Adam' },
      } as unknown as TripShare;
    }

    /** Pull the per-day TripDay create() bodies out of the mock in order. */
    function dayBodies(): Array<Record<string, unknown>> {
      return manager.create.mock.calls
        .map(([, body]) => body as Record<string, unknown>)
        .filter(
          (b) => 'day_number' in b && 'trip_id' in b && 'route_geom' in b,
        );
    }

    /** Pull the waypoint create() bodies grouped per saved trip_day_id. */
    function waypointBodiesByDayId(): Map<
      string | undefined,
      Array<Record<string, unknown>>
    > {
      const byDay = new Map<
        string | undefined,
        Array<Record<string, unknown>>
      >();
      for (const [, body] of manager.create.mock.calls) {
        const b = body as Record<string, unknown>;
        if (!('waypoint_type' in b)) continue;
        const id = b.trip_day_id as string | undefined;
        const list = byDay.get(id) ?? [];
        list.push(b);
        byDay.set(id, list);
      }
      return byDay;
    }

    beforeEach(() => {
      // Hand each saved entity a stable id so the day → waypoint
      // grouping in `waypointBodiesByDayId` lines up across calls. The
      // default mock recycles the same TRIP_ID for every entity which
      // would collapse multi-day waypoints into one bucket.
      let saveSeq = 0;
      manager.save.mockImplementation((entity: { id?: string }) => {
        saveSeq += 1;
        return Promise.resolve({
          ...entity,
          id: entity.id ?? `entity-${saveSeq}`,
          created_at: NOW,
          updated_at: NOW,
          joined_at: NOW,
        });
      });
    });

    it('reconstructs a 3-day trip with one trip_days row per snapshot day (acceptance test)', async () => {
      // The acceptance criterion in #357: a 3-day shared trip imports as
      // 3 days. This test asserts day_number, per-day geometry, distance,
      // and waypoint preservation for the canonical happy path.
      tripShares.findActiveByToken.mockResolvedValueOnce(
        makeShare([
          {
            distanceKm: 220,
            coordinates: [
              [10.0, 46.0],
              [10.1, 46.05],
              [10.2, 46.1],
            ],
            waypoints: [
              { lat: 46.0, lng: 10.0, name: 'Start', type: 'start' },
              { lat: 46.05, lng: 10.1, name: 'Lunch', type: 'rest' },
            ],
          },
          {
            distanceKm: 180,
            coordinates: [
              [10.2, 46.1],
              [10.3, 46.2],
              [10.4, 46.3],
            ],
            waypoints: [
              { lat: 46.1, lng: 10.2, name: 'Hotel A', type: 'accommodation' },
              { lat: 46.3, lng: 10.4, name: 'Photo stop', type: 'photo' },
            ],
          },
          {
            distanceKm: 250,
            coordinates: [
              [10.4, 46.3],
              [10.5, 46.4],
              [10.6, 46.5],
            ],
            waypoints: [
              { lat: 46.4, lng: 10.5, name: 'Fuel', type: 'fuel' },
              { lat: 46.5, lng: 10.6, name: 'Finish', type: 'end' },
            ],
          },
        ]),
      );
      mockGetDetailReturns(
        makeOwnedTrip({
          status: 'planned',
          num_days: 3,
          title: 'Alps loop — 3 days',
        }),
      );

      const result = await service.importFromShare(OWNER_ID, {
        share_token: 'tok-deadbeef',
      });

      // Trip row carries num_days = 3 and per-day distance bookends.
      // min/max are computed from the snapshot's per-day distances:
      // min(180, 220, 250)=180, max=250.
      expect(manager.create).toHaveBeenCalledWith(
        Trip,
        expect.objectContaining({
          owner_id: OWNER_ID,
          title: 'Alps loop — 3 days',
          num_days: 3,
          daily_km_min: 180,
          daily_km_max: 250,
          status: 'planned',
          invite_code: expect.stringMatching(/^[A-Z2-9]{8}$/),
        }),
      );

      // 3 trip_days rows, numbered 1..3 in snapshot order, each with
      // the day's own [lng,lat] geometry preserved.
      const days = dayBodies();
      expect(days).toHaveLength(3);
      expect(days.map((d) => d.day_number)).toEqual([1, 2, 3]);
      expect(days[0].distance_km).toBeCloseTo(220);
      expect(days[1].distance_km).toBeCloseTo(180);
      expect(days[2].distance_km).toBeCloseTo(250);
      const day1Coords = (days[0].route_geom as { coordinates: number[][] })
        .coordinates;
      expect(day1Coords[0]).toEqual([10.0, 46.0]);
      expect(day1Coords[2]).toEqual([10.2, 46.1]);
      const day3Coords = (days[2].route_geom as { coordinates: number[][] })
        .coordinates;
      expect(day3Coords[0]).toEqual([10.4, 46.3]);
      expect(day3Coords[2]).toEqual([10.6, 46.5]);

      // Each saved day gets its OWN waypoints — the rich type vocabulary
      // (rest, accommodation, photo, fuel, start, end) all survives. The
      // legacy `/trips/import` path drops `accommodation` entirely
      // because its DTO doesn't accept the type — this assertion guards
      // the regression.
      const wpByDay = waypointBodiesByDayId();
      const allTypes = Array.from(wpByDay.values())
        .flat()
        .map((w) => w.waypoint_type);
      expect(allTypes).toContain('start');
      expect(allTypes).toContain('rest');
      expect(allTypes).toContain('accommodation');
      expect(allTypes).toContain('photo');
      expect(allTypes).toContain('fuel');
      expect(allTypes).toContain('end');

      // Sequence is per-day 0..n-1 (so the per-day index stays clean).
      for (const list of wpByDay.values()) {
        expect(list.map((w) => w.sequence)).toEqual(
          Array.from({ length: list.length }, (_, i) => i),
        );
      }

      expect(result.status).toBe('planned');
    });

    it('preserves multi-day structure for a 1-day snapshot (no flattening regression)', async () => {
      tripShares.findActiveByToken.mockResolvedValueOnce(
        makeShare([
          {
            distanceKm: 95,
            coordinates: [
              [10, 46],
              [10.05, 46.05],
              [10.1, 46.1],
            ],
            waypoints: [
              { lat: 46, lng: 10, name: 'Start', type: 'start' },
              { lat: 46.1, lng: 10.1, name: 'End', type: 'end' },
            ],
          },
        ]),
      );
      mockGetDetailReturns(makeOwnedTrip({ status: 'planned', num_days: 1 }));

      await service.importFromShare(OWNER_ID, {
        share_token: 'tok-1d',
      });

      expect(manager.create).toHaveBeenCalledWith(
        Trip,
        expect.objectContaining({
          num_days: 1,
          daily_km_min: 95,
          daily_km_max: 95,
        }),
      );
      expect(dayBodies()).toHaveLength(1);
    });

    it('renumbers days so a snapshot with sparse/duplicate dayNumbers still satisfies the (trip_id, day_number) unique index', async () => {
      // Older companion exports could emit `dayNumber: 1, 1, 3` after
      // a mid-list day was deleted client-side. We renumber to 1..N to
      // avoid tripping the unique index and to keep the day list dense.
      const share = makeShare([
        { distanceKm: 100 },
        { distanceKm: 110 },
        { distanceKm: 120 },
      ]);
      // Mutate dayNumbers in the snapshot to (1, 1, 3) — the bug shape.
      (
        share.snapshot as { days: Array<{ dayNumber: number }> }
      ).days[1].dayNumber = 1;
      (
        share.snapshot as { days: Array<{ dayNumber: number }> }
      ).days[2].dayNumber = 3;
      tripShares.findActiveByToken.mockResolvedValueOnce(share);
      mockGetDetailReturns(makeOwnedTrip({ status: 'planned', num_days: 3 }));

      // Each day still needs at least geometry OR waypoints to survive
      // the "no usable data" filter — give every day a 2-point line.
      for (const d of (
        share.snapshot as { days: Array<{ routeGeometry: unknown }> }
      ).days) {
        d.routeGeometry = {
          type: 'LineString',
          coordinates: [
            [10, 46],
            [10.1, 46.1],
          ],
        };
      }

      await service.importFromShare(OWNER_ID, { share_token: 'tok-renum' });

      const days = dayBodies();
      expect(days).toHaveLength(3);
      expect(days.map((d) => d.day_number)).toEqual([1, 2, 3]);
    });

    it('drops days with neither geometry nor waypoints rather than persisting empty rows', async () => {
      // Empty days carry no information the rider could ride. They get
      // skipped, and the surviving days are renumbered so the day_number
      // sequence stays dense (no gap at the dropped position).
      tripShares.findActiveByToken.mockResolvedValueOnce(
        makeShare([
          {
            distanceKm: 50,
            coordinates: [
              [10, 46],
              [10.1, 46.1],
            ],
          },
          // Empty middle day — no geometry, no waypoints.
          { distanceKm: 0, waypoints: [] },
          {
            distanceKm: 75,
            coordinates: [
              [10.2, 46.2],
              [10.3, 46.3],
            ],
          },
        ]),
      );
      mockGetDetailReturns(makeOwnedTrip({ status: 'planned', num_days: 2 }));

      await service.importFromShare(OWNER_ID, { share_token: 'tok-empty' });

      const days = dayBodies();
      expect(days).toHaveLength(2);
      expect(days.map((d) => d.day_number)).toEqual([1, 2]);
    });

    it('400s when the snapshot has zero usable days', async () => {
      // Every day is empty/malformed — the rider should see a clear
      // "snapshot is broken" error, not a 201 returning an empty trip.
      tripShares.findActiveByToken.mockResolvedValueOnce(
        makeShare([
          { distanceKm: 0, waypoints: [] },
          { distanceKm: 0, waypoints: [] },
        ]),
      );

      await expect(
        service.importFromShare(OWNER_ID, { share_token: 'tok-broken' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(transactionMock).not.toHaveBeenCalled();
    });

    it('400s when the snapshot has no days[] array at all', async () => {
      tripShares.findActiveByToken.mockResolvedValueOnce({
        id: 'share-1',
        owner_id: 'owner-x',
        share_token: 'tok-shape',
        title: 'Broken shape',
        view_count: 0,
        created_at: NOW,
        updated_at: NOW,
        snapshot: { name: 'no days here' },
        owner: { display_name: 'Adam' },
      } as unknown as TripShare);

      await expect(
        service.importFromShare(OWNER_ID, { share_token: 'tok-shape' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(transactionMock).not.toHaveBeenCalled();
    });

    it('falls back to waypoint coordinates when a day carries no route geometry', async () => {
      // Older shares (or freshly-edited days the planner hasn't routed
      // yet) can land here without a `routeGeometry` block. The day
      // still carries information — skip the geometry but persist the
      // waypoints so the rider sees the planned stops.
      tripShares.findActiveByToken.mockResolvedValueOnce(
        makeShare([
          {
            distanceKm: 30,
            // No coordinates — only waypoints carry geographic info.
            waypoints: [
              { lat: 46, lng: 10, name: 'Start', type: 'start' },
              { lat: 46.1, lng: 10.1, name: 'End', type: 'end' },
            ],
          },
        ]),
      );
      mockGetDetailReturns(makeOwnedTrip({ status: 'planned', num_days: 1 }));

      await service.importFromShare(OWNER_ID, { share_token: 'tok-nogeom' });

      const days = dayBodies();
      expect(days).toHaveLength(1);
      // route_geom stays null (geometry < 2 points) but the waypoints
      // still get persisted under that day.
      expect(days[0].route_geom).toBeNull();
      const wpByDay = waypointBodiesByDayId();
      const wps = Array.from(wpByDay.values()).flat();
      expect(wps.map((w) => w.waypoint_type)).toEqual(['start', 'end']);
    });

    it('skips malformed coordinate entries and out-of-range lat/lng without throwing', async () => {
      tripShares.findActiveByToken.mockResolvedValueOnce(
        makeShare([
          {
            distanceKm: 50,
            coordinates: [
              [10, 46],
              [200, 91] as [number, number], // out of range — skipped
              [10.1, 46.1],
              // malformed entries below the cast — TS won't accept them
              // in the helper signature, but the runtime parser must
              // tolerate them since snapshots are opaque JSONB.
              ['bad', 'data'] as unknown as [number, number],
              [10.2, 46.2],
            ],
          },
        ]),
      );
      mockGetDetailReturns(makeOwnedTrip({ status: 'planned', num_days: 1 }));

      await service.importFromShare(OWNER_ID, {
        share_token: 'tok-bad-coords',
      });

      const days = dayBodies();
      const coords = (days[0].route_geom as { coordinates: number[][] })
        .coordinates;
      // Only the 3 valid entries survive — the in-range ones, in order.
      expect(coords).toEqual([
        [10, 46],
        [10.1, 46.1],
        [10.2, 46.2],
      ]);
    });

    it('coerces an unknown waypoint type to via instead of dropping the waypoint', async () => {
      // A snapshot from a future companion that introduces a new type
      // (e.g. `viewpoint`) shouldn't lose the stop entirely — fall back
      // to `via` so the rider still sees a planned waypoint there.
      tripShares.findActiveByToken.mockResolvedValueOnce(
        makeShare([
          {
            distanceKm: 50,
            coordinates: [
              [10, 46],
              [10.1, 46.1],
            ],
            waypoints: [
              { lat: 46, lng: 10, name: 'Mystery', type: 'viewpoint' },
            ],
          },
        ]),
      );
      mockGetDetailReturns(makeOwnedTrip({ status: 'planned', num_days: 1 }));

      await service.importFromShare(OWNER_ID, {
        share_token: 'tok-future-type',
      });

      const wps = Array.from(waypointBodiesByDayId().values()).flat();
      expect(wps).toHaveLength(1);
      expect(wps[0]).toMatchObject({ waypoint_type: 'via', name: 'Mystery' });
    });

    it('propagates the share lookup 404 when the token is unknown', async () => {
      // The trip-shares service collapses unknown-token and
      // soft-deleted-owner into the same NotFoundException; the import
      // path must surface that as-is so the mobile client can render
      // "this handoff link has expired or was revoked."
      tripShares.findActiveByToken.mockRejectedValueOnce(
        new NotFoundException('Trip share not found'),
      );

      await expect(
        service.importFromShare(OWNER_ID, { share_token: 'tok-unknown' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(transactionMock).not.toHaveBeenCalled();
    });

    it('does NOT bump the share view_count (analytics integrity)', async () => {
      // The view counter is meant to track external link traffic — an
      // authenticated server-side import would inflate that signal.
      // Asserting we route through `findActiveByToken` (the no-bump
      // method) rather than `getByToken` is what guarantees this.
      tripShares.findActiveByToken.mockResolvedValueOnce(
        makeShare([
          {
            distanceKm: 50,
            coordinates: [
              [10, 46],
              [10.1, 46.1],
            ],
          },
        ]),
      );
      mockGetDetailReturns(makeOwnedTrip({ status: 'planned', num_days: 1 }));

      await service.importFromShare(OWNER_ID, { share_token: 'tok-quiet' });

      expect(tripShares.findActiveByToken).toHaveBeenCalledTimes(1);
      expect(tripShares.findActiveByToken).toHaveBeenCalledWith('tok-quiet');
    });

    it('recovers per-day distance from geometry when the snapshot omits distanceKm', async () => {
      // Older shares (pre-distanceKm field) would otherwise surface as
      // "0 km" days in the trip list. Falling back to a haversine sum
      // over the geometry keeps the import useful.
      tripShares.findActiveByToken.mockResolvedValueOnce(
        makeShare([
          {
            distanceKm: 0,
            coordinates: [
              [10.0, 46.0],
              [10.1, 46.1],
              [10.2, 46.2],
            ],
          },
        ]),
      );
      mockGetDetailReturns(makeOwnedTrip({ status: 'planned', num_days: 1 }));

      await service.importFromShare(OWNER_ID, { share_token: 'tok-no-dist' });

      const days = dayBodies();
      expect(days).toHaveLength(1);
      // Two ~14km legs ≈ 28km total, well above zero. We don't assert
      // an exact value (haversine on these coords is an approximation)
      // but it must be > 0 and the day must satisfy the schema's
      // positive-number constraint via the floor in the bounds calc.
      expect(days[0].distance_km as number).toBeGreaterThan(0);
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
      tripRepo.findOne.mockResolvedValueOnce(makeOwnedTrip()); // empty-PATCH existence probe
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

  describe('remove', () => {
    it('deletes the trip, emits trip:deleted, and resolves void when caller is owner', async () => {
      memberRepo.findOne.mockResolvedValueOnce({
        role: 'owner',
      } as TripMember);
      const callOrder: string[] = [];
      (tripRepo.delete as jest.Mock) = jest.fn().mockImplementation(() => {
        callOrder.push('delete');
        return Promise.resolve({ affected: 1 });
      });
      events.emitToTrip.mockImplementation(() => {
        callOrder.push('emit');
      });

      await expect(service.remove(OWNER_ID, TRIP_ID)).resolves.toBeUndefined();

      expect(tripRepo.delete).toHaveBeenCalledWith({ id: TRIP_ID });
      expect(events.emitToTrip).toHaveBeenCalledWith(TRIP_ID, 'trip:deleted', {
        trip_id: TRIP_ID,
      });
      // The emit must run AFTER the delete commits so a failed delete
      // doesn't broadcast a deletion that didn't happen — collaborators
      // would otherwise tear down their subscriptions for a trip that
      // still exists.
      expect(callOrder).toEqual(['delete', 'emit']);
      // Cascade FKs delete the activity row anyway, so we deliberately
      // skip writing one.
      expect(activity.recordSafe).not.toHaveBeenCalled();
    });

    it('does not emit trip:deleted when the delete fails', async () => {
      // Without this guarantee live collaborators would receive a false
      // deletion notification on a transient DB error and tear down
      // their subscription for a trip that still exists.
      memberRepo.findOne.mockResolvedValueOnce({
        role: 'owner',
      } as TripMember);
      (tripRepo.delete as jest.Mock) = jest
        .fn()
        .mockRejectedValue(new Error('connection lost'));

      await expect(service.remove(OWNER_ID, TRIP_ID)).rejects.toThrow(
        'connection lost',
      );
      expect(events.emitToTrip).not.toHaveBeenCalled();
    });

    it('404s and skips the emit when the delete affects 0 rows (concurrent double-delete)', async () => {
      // Two requests from the same owner can both pass the membership
      // check before either DELETE lands. The loser should see a 404
      // instead of a duplicate `trip:deleted` broadcast that would tear
      // down already-disconnected collaborators a second time.
      memberRepo.findOne.mockResolvedValueOnce({
        role: 'owner',
      } as TripMember);
      (tripRepo.delete as jest.Mock) = jest
        .fn()
        .mockResolvedValue({ affected: 0 });

      await expect(service.remove(OWNER_ID, TRIP_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(events.emitToTrip).not.toHaveBeenCalled();
    });

    it('404s a non-owner (admins, members, non-members all collapse)', async () => {
      (tripRepo.delete as jest.Mock) = jest.fn();

      for (const role of ['admin', 'member'] as const) {
        memberRepo.findOne.mockResolvedValueOnce({ role } as TripMember);
        await expect(service.remove(OTHER_ID, TRIP_ID)).rejects.toBeInstanceOf(
          NotFoundException,
        );
      }

      memberRepo.findOne.mockResolvedValueOnce(null); // non-member
      await expect(service.remove(OTHER_ID, TRIP_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );

      expect(tripRepo.delete).not.toHaveBeenCalled();
      expect(events.emitToTrip).not.toHaveBeenCalled();
    });
  });

  describe('invite', () => {
    const RECIPIENT = 'rider@example.com';

    beforeEach(() => {
      tripRepo.findOne = jest.fn().mockResolvedValue(makeOwnedTrip());
    });

    it('owner sends a trip-invite email and records audit activity', async () => {
      memberRepo.findOne.mockResolvedValueOnce({
        role: 'owner',
      } as TripMember);
      // First userRepo.findOne resolves the inviter; second checks for a
      // pre-existing recipient account.
      userRepo.findOne
        .mockResolvedValueOnce({
          id: OWNER_ID,
          display_name: 'Adam',
          email: 'adam@example.com',
        } as User)
        .mockResolvedValueOnce(null);

      await expect(
        service.invite(OWNER_ID, TRIP_ID, {
          email: RECIPIENT,
          message: 'Come ride with us!',
        }),
      ).resolves.toBeUndefined();

      expect(email.sendTripInvite).toHaveBeenCalledTimes(1);
      const [to, ctx] = email.sendTripInvite.mock.calls[0];
      expect(to).toBe(RECIPIENT);
      expect(ctx).toMatchObject({
        inviterDisplayName: 'Adam',
        tripTitle: 'Big Italian Loop',
        inviteCode: 'ABCDEFGH',
        message: 'Come ride with us!',
      });
      expect(ctx.joinUrl).toBe(
        `https://app.tarmoto.test/trips/join?trip_id=${TRIP_ID}&code=ABCDEFGH`,
      );

      expect(activity.recordSafe).toHaveBeenCalledWith(
        TRIP_ID,
        OWNER_ID,
        'member_invited',
        { recipient_email_domain: 'example.com', message_provided: true },
      );
    });

    it('admin can also send invites (only owner+admin are privileged)', async () => {
      memberRepo.findOne.mockResolvedValueOnce({
        role: 'admin',
      } as TripMember);
      userRepo.findOne
        .mockResolvedValueOnce({
          id: OTHER_ID,
          display_name: 'Eve',
          email: 'eve@example.com',
        } as User)
        .mockResolvedValueOnce(null);

      await expect(
        service.invite(OTHER_ID, TRIP_ID, { email: RECIPIENT }),
      ).resolves.toBeUndefined();
      expect(email.sendTripInvite).toHaveBeenCalledTimes(1);
      expect(activity.recordSafe).toHaveBeenCalledWith(
        TRIP_ID,
        OTHER_ID,
        'member_invited',
        { recipient_email_domain: 'example.com', message_provided: false },
      );
    });

    it('404s plain members and non-members without sending mail', async () => {
      // Plain member — non-privileged role.
      memberRepo.findOne.mockResolvedValueOnce({
        role: 'member',
      } as TripMember);
      await expect(
        service.invite(OTHER_ID, TRIP_ID, { email: RECIPIENT }),
      ).rejects.toBeInstanceOf(NotFoundException);

      // Non-member.
      memberRepo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.invite(OTHER_ID, TRIP_ID, { email: RECIPIENT }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(email.sendTripInvite).not.toHaveBeenCalled();
      expect(activity.recordSafe).not.toHaveBeenCalled();
    });

    it('rejects self-invite with a 400 (caller is already a member)', async () => {
      memberRepo.findOne.mockResolvedValueOnce({
        role: 'owner',
      } as TripMember);
      userRepo.findOne.mockResolvedValueOnce({
        id: OWNER_ID,
        display_name: 'Adam',
        email: RECIPIENT,
      } as User);

      await expect(
        service.invite(OWNER_ID, TRIP_ID, { email: RECIPIENT }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(email.sendTripInvite).not.toHaveBeenCalled();
      expect(activity.recordSafe).not.toHaveBeenCalled();
    });

    it('skips the email but still records activity when the recipient is already a teammate', async () => {
      memberRepo.findOne
        .mockResolvedValueOnce({ role: 'owner' } as TripMember) // caller
        .mockResolvedValueOnce({
          // recipient already a member
          trip_id: TRIP_ID,
          user_id: OTHER_ID,
          role: 'member',
        } as TripMember);
      userRepo.findOne
        .mockResolvedValueOnce({
          id: OWNER_ID,
          display_name: 'Adam',
          email: 'adam@example.com',
        } as User)
        .mockResolvedValueOnce({ id: OTHER_ID, email: RECIPIENT } as User);

      await expect(
        service.invite(OWNER_ID, TRIP_ID, { email: RECIPIENT }),
      ).resolves.toBeUndefined();

      expect(email.sendTripInvite).not.toHaveBeenCalled();
      expect(activity.recordSafe).toHaveBeenCalledWith(
        TRIP_ID,
        OWNER_ID,
        'member_invited',
        { recipient_email_domain: 'example.com', already_member: true },
      );
    });

    it('payload only carries the email domain — local-part is dropped to limit PII in the audit log', async () => {
      memberRepo.findOne.mockResolvedValueOnce({
        role: 'owner',
      } as TripMember);
      userRepo.findOne
        .mockResolvedValueOnce({
          id: OWNER_ID,
          display_name: 'Adam',
          email: 'adam@example.com',
        } as User)
        .mockResolvedValueOnce(null);

      await service.invite(OWNER_ID, TRIP_ID, {
        email: 'private.address+plus@gmail.com',
      });

      const payload = activity.recordSafe.mock.calls[0][3] as Record<
        string,
        unknown
      >;
      expect(payload.recipient_email_domain).toBe('gmail.com');
      // Local-part must NOT survive into the activity row — it would
      // outlive the trip and persist someone else's email forever.
      expect(JSON.stringify(payload)).not.toContain('private.address');
      expect(JSON.stringify(payload)).not.toContain('plus');
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
