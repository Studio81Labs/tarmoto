/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/unbound-method */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { In, Repository } from 'typeorm';
import { TripsService } from './trips.service.js';
import { Trip } from '../../entities/trip.entity.js';
import { TripDay } from '../../entities/trip-day.entity.js';
import { TripFolder } from '../../entities/trip-folder.entity.js';
import { TripMember } from '../../entities/trip-member.entity.js';
import { TripInvite } from '../../entities/trip-invite.entity.js';
import { TripSuggestion } from '../../entities/trip-suggestion.entity.js';
import { TripShare } from '../../entities/trip-share.entity.js';
import { RouteCollectionItem } from '../../entities/route-collection-item.entity.js';
import { User } from '../../entities/user.entity.js';
import { EmailService } from '../email/email.service.js';
import { EventsGateway } from '../events/events.gateway.js';
import { TripActivityService } from '../trip-activity/trip-activity.service.js';
import { TripSharesService } from '../trip-shares/trip-shares.service.js';
import { PrivacyPreferencesService } from '../account/privacy-preferences.service.js';
import { ROUTING_PROVIDER } from '../commute/routing-provider.interface.js';
import { RouteEnrichmentService } from '../routing/route-enrichment.service.js';

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
  getExists: jest.Mock;
};

function makeQbMock(
  returns: { getMany?: Trip[]; getOne?: Trip | null; getExists?: boolean } = {},
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
  qb.getExists = jest.fn().mockResolvedValue(returns.getExists ?? false);
  return qb;
}

// Shape of one aggregate row returned by the trip_days rollup query that
// `list` runs to derive distance_km / quality_avg / passes_count.
type AggRow = {
  trip_id: string;
  distance_km: string | null;
  quality_avg: string | null;
  passes_count: string | null;
};

type AggQbMock = {
  select: jest.Mock;
  addSelect: jest.Mock;
  where: jest.Mock;
  groupBy: jest.Mock;
  getRawMany: jest.Mock;
};

function makeAggQbMock(rows: AggRow[]): AggQbMock {
  const qb = {} as AggQbMock;
  for (const m of ['select', 'addSelect', 'where', 'groupBy'] as const) {
    (qb as Record<string, jest.Mock>)[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getRawMany = jest.fn().mockResolvedValue(rows);
  return qb;
}

describe('TripsService', () => {
  let service: TripsService;
  let tripRepo: jest.Mocked<Repository<Trip>>;
  let tripDayRepo: jest.Mocked<Repository<TripDay>>;
  let memberRepo: jest.Mocked<Repository<TripMember>>;
  let manager: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  // Pulled out alongside `manager` so tests can call `mockImplementation`
  // / `mockRejectedValue` on a properly-typed `jest.Mock` without lint
  // tripping on the deeply-nested mock cast on `tripRepo.manager.*`.
  let transactionMock: jest.Mock;
  let userRepo: jest.Mocked<Repository<User>>;
  let inviteRepo: jest.Mocked<Repository<TripInvite>>;
  let folderRepo: jest.Mocked<Repository<TripFolder>>;
  let collectionItemRepo: jest.Mocked<Repository<RouteCollectionItem>>;
  let events: jest.Mocked<Pick<EventsGateway, 'emitToTrip' | 'evictFromTrip'>>;
  let activity: jest.Mocked<Pick<TripActivityService, 'recordSafe'>>;
  let tripShares: jest.Mocked<Pick<TripSharesService, 'findActiveByToken'>>;
  let email: jest.Mocked<Pick<EmailService, 'sendTripInvite'>>;
  let config: jest.Mocked<Pick<ConfigService, 'get'>>;
  let privacy: jest.Mocked<
    Pick<PrivacyPreferencesService, 'loadPrivateUserIds'>
  >;
  let routingProvider: {
    route: jest.Mock;
    getAlternatives: jest.Mock;
    version: string;
  };
  let enrichment: { aggregate: jest.Mock };

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
      find: jest.fn().mockResolvedValue([]),
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

    // The trip-summary rollup query in `list` runs on `tripDayRepo`. Default
    // to an empty aggregate so existing list tests (which don't care about
    // the derived fields) keep passing; specific tests override the rows.
    tripDayRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(makeAggQbMock([])),
    } as unknown as jest.Mocked<Repository<TripDay>>;

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
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    } as unknown as jest.Mocked<Repository<TripMember>>;

    userRepo = {
      findOne: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<Repository<User>>;

    inviteRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      insert: jest.fn().mockResolvedValue({ identifiers: [{ id: 'inv-1' }] }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      save: jest.fn().mockImplementation((e: TripInvite) => Promise.resolve(e)),
    } as unknown as jest.Mocked<Repository<TripInvite>>;

    folderRepo = {
      findOne: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<Repository<TripFolder>>;

    // Defaults to "not exposed" so existing tests that never touch the
    // community read path are unaffected; getPublicDetail tests override.
    collectionItemRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(makeQbMock()),
    } as unknown as jest.Mocked<Repository<RouteCollectionItem>>;

    events = {
      emitToTrip: jest.fn(),
      evictFromTrip: jest.fn().mockResolvedValue(undefined),
    };
    activity = { recordSafe: jest.fn().mockResolvedValue(undefined) };
    tripShares = { findActiveByToken: jest.fn() };
    // Default: nobody is private, so owner identity is unmasked unless a test
    // opts in by returning a Set containing the owner id.
    privacy = {
      loadPrivateUserIds: jest.fn().mockResolvedValue(new Set<string>()),
    };
    email = { sendTripInvite: jest.fn().mockResolvedValue(null) };
    config = {
      get: jest.fn((key: string) =>
        key === 'TARMOTO_COMPANION_URL'
          ? 'https://app.tarmoto.test'
          : undefined,
      ),
    } as unknown as jest.Mocked<Pick<ConfigService, 'get'>>;

    routingProvider = {
      version: 'valhalla-v1',
      route: jest.fn().mockResolvedValue(null),
      getAlternatives: jest.fn().mockResolvedValue([]),
    };

    enrichment = {
      aggregate: jest.fn().mockResolvedValue({
        avgQuality: null,
        curvinessScore: null,
        scenicScore: null,
        elevationGain: 0,
        elevationLoss: 0,
        hazardCount: 0,
        surfaceMixMetres: {},
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TripsService,
        { provide: getRepositoryToken(Trip), useValue: tripRepo },
        { provide: getRepositoryToken(TripDay), useValue: tripDayRepo },
        { provide: getRepositoryToken(TripMember), useValue: memberRepo },
        { provide: getRepositoryToken(TripFolder), useValue: folderRepo },
        {
          provide: getRepositoryToken(RouteCollectionItem),
          useValue: collectionItemRepo,
        },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: getRepositoryToken(TripInvite), useValue: inviteRepo },
        { provide: EventsGateway, useValue: events },
        { provide: TripActivityService, useValue: activity },
        { provide: TripSharesService, useValue: tripShares },
        { provide: EmailService, useValue: email },
        { provide: ConfigService, useValue: config },
        { provide: PrivacyPreferencesService, useValue: privacy },
        { provide: ROUTING_PROVIDER, useValue: routingProvider },
        { provide: RouteEnrichmentService, useValue: enrichment },
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

  /** Wire the trip_days rollup query (run on tripDayRepo) to return `rows`. */
  function mockListAggReturns(rows: AggRow[]): AggQbMock {
    const qb = makeAggQbMock(rows);
    tripDayRepo.createQueryBuilder.mockReturnValue(qb as never);
    return qb;
  }

  describe('create', () => {
    it('persists trip + owner membership and returns the detail', async () => {
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

    it('US-37: persists folder_id when the caller owns the folder (duplicate path)', async () => {
      // The companion's "Duplicate" action posts the source trip's
      // folder_id back through `POST /trips`. Without folder_id on
      // CreateTripDto + this ownership check, the global ValidationPipe
      // (forbidNonWhitelisted) would 400 every duplicate of a filed
      // trip.
      folderRepo.findOne.mockResolvedValueOnce({
        id: 'fld-1',
        user_id: OWNER_ID,
      } as TripFolder);
      mockGetDetailReturns(makeOwnedTrip({ folder_id: 'fld-1' }));

      await service.create(OWNER_ID, {
        title: 'Filed Loop',
        num_days: 3,
        folder_id: 'fld-1',
      });

      expect(folderRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'fld-1', user_id: OWNER_ID },
      });
      expect(manager.create).toHaveBeenCalledWith(
        Trip,
        expect.objectContaining({ folder_id: 'fld-1' }),
      );
    });

    it('duplicate copies each day-level leg_preferences onto the new trip', async () => {
      // Without the copy, a duplicated trip reloads with every leg
      // inherited and the next save reroutes the rider-approved custom
      // legs with the trip-wide preference.
      tripRepo.findOne.mockResolvedValueOnce(
        makeOwnedTrip({
          days: [
            {
              id: 'src-day-1',
              day_number: 1,
              title: null,
              distance_km: 120,
              route_geom: null,
              avg_quality: null,
              elevation_gain: null,
              elevation_loss: null,
              curviness_score: null,
              scenic_score: null,
              estimated_time: null,
              start_linked: false,
              leg_preferences: ['direct', 'maximum_twisty'],
              waypoints: [],
            },
          ],
          members: [{ user_id: OWNER_ID, role: 'owner' }],
        } as unknown as Partial<Trip>),
      );
      mockGetDetailReturns(makeOwnedTrip());

      await service.duplicate(OWNER_ID, TRIP_ID);

      const dayBodies = manager.create.mock.calls
        .map(([, body]) => body as Record<string, unknown>)
        .filter((b) => 'day_number' in b);
      expect(dayBodies[0]).toMatchObject({
        leg_preferences: ['direct', 'maximum_twisty'],
      });
    });

    it('US-37: 404s when the supplied folder_id belongs to a different rider', async () => {
      folderRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.create(OWNER_ID, {
          title: 'Hijack',
          num_days: 3,
          folder_id: 'fld-other',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Folder ownership probe happens before any DB write, so the
      // transaction must not have run.
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
        startLinked?: boolean;
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
            startLinked: d.startLinked ?? false,
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
      // survives, canonicalized to the BACKEND vocabulary so the companion
      // remaps stays on reload: snapshot `rest`→`coffee`, `accommodation`→
      // `hotel` (a raw `accommodation` would fall through to `via`). The legacy
      // `/trips/import` path drops stays entirely — this guards the regression.
      const wpByDay = waypointBodiesByDayId();
      const allTypes = Array.from(wpByDay.values())
        .flat()
        .map((w) => w.waypoint_type);
      expect(allTypes).toContain('start');
      expect(allTypes).toContain('coffee'); // snapshot `rest` canonicalized
      expect(allTypes).toContain('hotel'); // snapshot `accommodation` canonicalized
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

    it('carries startLinked from the share snapshot when the start sits on the previous end', async () => {
      tripShares.findActiveByToken.mockResolvedValueOnce(
        makeShare([
          {
            distanceKm: 50,
            coordinates: [
              [10, 46],
              [10.1, 46.1],
            ],
            waypoints: [
              { lat: 46, lng: 10, type: 'start' },
              { lat: 46.1, lng: 10.1, type: 'end' }, // day 1 ends here
            ],
          },
          {
            distanceKm: 60,
            coordinates: [
              [10.1, 46.1],
              [10.2, 46.2],
            ],
            startLinked: true,
            waypoints: [
              { lat: 46.1, lng: 10.1, type: 'start' }, // == day 1 end → valid link
              { lat: 46.2, lng: 10.2, type: 'end' },
            ],
          },
        ]),
      );
      mockGetDetailReturns(makeOwnedTrip({ status: 'planned', num_days: 2 }));

      await service.importFromShare(OWNER_ID, { share_token: 'tok-link' });

      const days = dayBodies();
      expect(days).toHaveLength(2);
      expect(days[0].start_linked).toBe(false); // day 1 is never linked
      expect(days[1].start_linked).toBe(true); // valid link carried through
    });

    it('clears an imported link whose start does not sit on the previous end', async () => {
      tripShares.findActiveByToken.mockResolvedValueOnce(
        makeShare([
          {
            distanceKm: 50,
            coordinates: [
              [10, 46],
              [10.1, 46.1],
            ],
            waypoints: [
              { lat: 46, lng: 10, type: 'start' },
              { lat: 46.1, lng: 10.1, type: 'end' }, // day 1 ends here
            ],
          },
          {
            distanceKm: 60,
            coordinates: [
              [10.5, 46.5],
              [10.6, 46.6],
            ],
            startLinked: true, // claims linked…
            waypoints: [
              { lat: 46.5, lng: 10.5, type: 'start' }, // …but start ≠ day 1 end
              { lat: 46.6, lng: 10.6, type: 'end' },
            ],
          },
        ]),
      );
      mockGetDetailReturns(makeOwnedTrip({ status: 'planned', num_days: 2 }));

      await service.importFromShare(OWNER_ID, { share_token: 'tok-badlink' });

      const days = dayBodies();
      expect(days).toHaveLength(2);
      expect(days[1].start_linked).toBe(false); // impossible link cleared
    });

    it('keeps a shared link when the predecessor finishes at a terminal accommodation', async () => {
      tripShares.findActiveByToken.mockResolvedValueOnce(
        makeShare([
          {
            distanceKm: 50,
            coordinates: [
              [10, 46],
              [10.1, 46.1],
            ],
            waypoints: [
              { lat: 46, lng: 10, type: 'start' },
              // Generated overnight finish: terminal accommodation, no `end`.
              { lat: 46.1, lng: 10.1, type: 'accommodation' },
            ],
          },
          {
            distanceKm: 60,
            coordinates: [
              [10.1, 46.1],
              [10.2, 46.2],
            ],
            startLinked: true,
            waypoints: [
              { lat: 46.1, lng: 10.1, type: 'start' }, // == day 1's overnight
              { lat: 46.2, lng: 10.2, type: 'end' },
            ],
          },
        ]),
      );
      mockGetDetailReturns(makeOwnedTrip({ status: 'planned', num_days: 2 }));

      await service.importFromShare(OWNER_ID, { share_token: 'tok-hotel' });

      const days = dayBodies();
      expect(days).toHaveLength(2);
      // Day 2's start sits on day 1's overnight accommodation → link preserved.
      expect(days[1].start_linked).toBe(true);
    });

    it('prefers a terminal stay over an earlier end when validating a shared link', async () => {
      tripShares.findActiveByToken.mockResolvedValueOnce(
        makeShare([
          {
            distanceKm: 50,
            coordinates: [
              [10, 46],
              [10.5, 46.5],
            ],
            waypoints: [
              { lat: 46, lng: 10, type: 'start' },
              { lat: 46.1, lng: 10.1, type: 'end' }, // earlier explicit end
              { lat: 46.5, lng: 10.5, type: 'accommodation' }, // stay = real finish
            ],
          },
          {
            distanceKm: 60,
            coordinates: [
              [10.5, 46.5],
              [10.6, 46.6],
            ],
            startLinked: true,
            waypoints: [
              { lat: 46.5, lng: 10.5, type: 'start' }, // == the terminal stay, not the end
              { lat: 46.6, lng: 10.6, type: 'end' },
            ],
          },
        ]),
      );
      mockGetDetailReturns(makeOwnedTrip({ status: 'planned', num_days: 2 }));

      await service.importFromShare(OWNER_ID, { share_token: 'tok-stay-end' });

      const days = dayBodies();
      expect(days).toHaveLength(2);
      // Validated against the terminal stay (46.5,10.5), not the earlier end.
      expect(days[1].start_linked).toBe(true);
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

    it('enriches the summary with the derived distance/quality/passes rollup', async () => {
      // C1: the trip-draft cards on the companion home read distance_km,
      // quality_avg, and passes_count off the list summary. They are
      // derived live from the trip_days rollup query — the aggregate row's
      // numeric strings (pg returns SUM/AVG/COUNT as text) are coerced to
      // numbers. The second trip has NO matching aggregate row (no days
      // with usable data) and must surface null for all three.
      const enriched = makeOwnedTrip({ id: 't-1', title: 'A' });
      const empty = makeOwnedTrip({ id: 't-2', title: 'B' });
      [enriched, empty].forEach((t) => {
        t.member_count = 1;
      });
      mockListReturns([enriched, empty]);
      mockListAggReturns([
        {
          trip_id: 't-1',
          distance_km: '610',
          quality_avg: '4.4',
          passes_count: '6',
        },
      ]);

      const trips = await service.list(OWNER_ID, {});

      expect(trips[0].distance_km).toBe(610);
      expect(trips[0].quality_avg).toBeCloseTo(4.4);
      expect(trips[0].passes_count).toBe(6);
      // No aggregate row → all three derived fields are null (not 0), so
      // the card can distinguish "nothing planned yet" from "0 passes".
      expect(trips[1].distance_km).toBeNull();
      expect(trips[1].quality_avg).toBeNull();
      expect(trips[1].passes_count).toBeNull();
    });

    it('short-circuits the rollup query when no trips are visible', async () => {
      mockListReturns([]);
      const agg = mockListAggReturns([]);

      const result = await service.list(OWNER_ID, {});

      expect(result).toEqual([]);
      // Empty page must not pay for the (potentially expensive) spatial
      // rollup — the IN (:...ids) clause would also be malformed on [].
      expect(agg.getRawMany).not.toHaveBeenCalled();
    });
  });

  describe('getDetail', () => {
    it('returns the detail for a member', async () => {
      const qb = mockGetDetailReturns(makeOwnedTrip());

      const result = await service.getDetail(OWNER_ID, TRIP_ID);

      expect(result.id).toBe(TRIP_ID);
      // Membership predicate is in the SQL, so non-members would never
      // have hydrated the deep relations to begin with.
      expect(qb.innerJoin).toHaveBeenCalledWith(
        TripMember,
        'caller',
        'caller.trip_id = trip.id AND caller.user_id = :userId',
        { userId: OWNER_ID },
      );
    });

    it('populates the summary rollups (distance/quality/passes) on detail', async () => {
      // Regression: TripDetailDto inherits these fields, so a detail-derived
      // summary row (e.g. the optimistic duplicate-trip insert) must carry
      // the same metadata as a list summary, not nulls.
      mockGetDetailReturns(makeOwnedTrip());
      mockListAggReturns([
        {
          trip_id: TRIP_ID,
          distance_km: '610',
          quality_avg: '4.4',
          passes_count: '6',
        },
      ]);

      const result = await service.getDetail(OWNER_ID, TRIP_ID);

      expect(result.distance_km).toBe(610);
      expect(result.quality_avg).toBeCloseTo(4.4);
      expect(result.passes_count).toBe(6);
    });

    it('leaves rollups null on detail when the trip has no day aggregate', async () => {
      mockGetDetailReturns(makeOwnedTrip());
      mockListAggReturns([]); // no trip_days rows for this trip

      const result = await service.getDetail(OWNER_ID, TRIP_ID);

      expect(result.distance_km).toBeNull();
      expect(result.quality_avg).toBeNull();
      expect(result.passes_count).toBeNull();
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

  describe('getPublicDetail', () => {
    /** Wire the collection-exposure existence check to resolve `exposed`. */
    function mockExposed(exposed: boolean): QbMock {
      const qb = makeQbMock({ getExists: exposed });
      collectionItemRepo.createQueryBuilder.mockReturnValue(qb as never);
      return qb;
    }

    it('returns masked detail (no invite_code/members) when the trip is exposed via a discoverable collection', async () => {
      mockGetDetailReturns(makeOwnedTrip());
      const itemQb = mockExposed(true);

      // OTHER_ID is not a member — access is granted purely by the collection.
      const result = await service.getPublicDetail(OTHER_ID, TRIP_ID);

      expect(result).not.toHaveProperty('invite_code');
      expect(result).not.toHaveProperty('members');
      // Owner-private fields that must never reach a non-member surface.
      expect(result).not.toHaveProperty('folder_id');
      // Owner display name is surfaced from the loaded roster.
      expect(result.owner_name).toBe('Adam');
      expect(result.owner_id).toBe(OWNER_ID);
      expect(result.member_count).toBe(1);
      expect(result.id).toBe(TRIP_ID);
      // The exposure check is scoped to public/unlisted collections only...
      expect(itemQb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('visibility'),
        expect.objectContaining({ visibilities: ['public', 'unlisted'] }),
      );
      // ...AND requires the collection owner to be a member of the trip, so an
      // arbitrary private trip_id parked in a public collection can't leak...
      expect(itemQb.innerJoin).toHaveBeenCalledWith(
        TripMember,
        'tm',
        'tm.trip_id = item.trip_id AND tm.user_id = c.owner_id',
      );
      // ...AND that the collection owner's account is live (a soft-deleted
      // owner's collections 404, so a stale link must stop exposing the trip).
      expect(itemQb.innerJoin).toHaveBeenCalledWith(
        User,
        'owner',
        'owner.id = c.owner_id AND owner.deleted_at IS NULL',
      );
    });

    it('allows a member without consulting collection visibility or owner privacy', async () => {
      mockGetDetailReturns(makeOwnedTrip());

      const result = await service.getPublicDetail(OWNER_ID, TRIP_ID);

      expect(result.owner_name).toBe('Adam');
      // A member short-circuits the collection exposure query entirely...
      expect(collectionItemRepo.createQueryBuilder).not.toHaveBeenCalled();
      // ...and never masks the owner (no privacy lookup needed).
      expect(privacy.loadPrivateUserIds).not.toHaveBeenCalled();
    });

    it('masks owner id + name for a non-member when the owner keeps a private profile', async () => {
      mockGetDetailReturns(makeOwnedTrip());
      mockExposed(true);
      privacy.loadPrivateUserIds.mockResolvedValueOnce(new Set([OWNER_ID]));

      const result = await service.getPublicDetail(OTHER_ID, TRIP_ID);

      // Identity is hidden, matching how the collection API masks a private
      // owner — the rest of the trip (days/geometry) still renders.
      expect(result.owner_id).toBeNull();
      expect(result.owner_name).toBeNull();
      expect(result.id).toBe(TRIP_ID);
      expect(privacy.loadPrivateUserIds).toHaveBeenCalledWith([OWNER_ID]);
    });

    it('masks owner id + name when the trip owner is soft-deleted, even with a public profile', async () => {
      // A live collaborator can expose a trip whose OWNER is mid-deletion; the
      // exposure join only proves the collection owner is live, so the trip
      // owner's soft-delete is checked here. Privacy stays empty (public).
      mockGetDetailReturns(
        makeOwnedTrip({
          members: [
            {
              id: 'm-1',
              trip_id: TRIP_ID,
              user_id: OWNER_ID,
              role: 'owner',
              joined_at: NOW,
              user: { display_name: 'Adam', deleted_at: NOW },
            } as unknown as TripMember,
          ],
        }),
      );
      mockExposed(true);

      const result = await service.getPublicDetail(OTHER_ID, TRIP_ID);

      expect(result.owner_id).toBeNull();
      expect(result.owner_name).toBeNull();
      expect(result.id).toBe(TRIP_ID);
    });

    it('404s when the trip is in no discoverable collection and the viewer is not a member', async () => {
      mockGetDetailReturns(makeOwnedTrip());
      mockExposed(false);

      await expect(
        service.getPublicDetail(OTHER_ID, TRIP_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s when the trip does not exist (anonymous viewer)', async () => {
      mockGetDetailReturns(null);

      await expect(
        service.getPublicDetail(null, TRIP_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      // No point checking collection exposure for a trip that doesn't exist.
      expect(collectionItemRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('collaborator management', () => {
    const memberRow = (over: Partial<TripMember>) =>
      ({
        id: 'm-x',
        trip_id: TRIP_ID,
        user_id: OTHER_ID,
        role: 'editor',
        joined_at: NOW,
        user: {
          id: OTHER_ID,
          display_name: 'Eve',
          email: 'eve@example.com',
          avatar_url: null,
        },
        ...over,
      }) as unknown as TripMember;

    it('lists members with emails + pending invites for the owner', async () => {
      memberRepo.findOne.mockResolvedValueOnce({
        role: 'owner',
      } as TripMember);
      memberRepo.find.mockResolvedValueOnce([
        memberRow({ user_id: OWNER_ID, role: 'owner' }),
        memberRow({}),
      ]);
      inviteRepo.find.mockResolvedValueOnce([
        {
          id: 'inv-1',
          trip_id: TRIP_ID,
          email: 'pending@example.com',
          role: 'viewer',
          invite_code: 'AAAABBBB',
          created_at: NOW,
        } as TripInvite,
      ]);

      const roster = await service.listCollaborators(OWNER_ID, TRIP_ID);

      expect(roster.members).toHaveLength(2);
      expect(roster.members[1]).toMatchObject({
        email: 'eve@example.com',
        role: 'editor',
        state: 'joined',
      });
      expect(roster.invites).toEqual([
        expect.objectContaining({
          email: 'pending@example.com',
          role: 'viewer',
          state: 'invited',
        }),
      ]);
    });

    it('hides emails and invites from viewers', async () => {
      memberRepo.findOne.mockResolvedValueOnce({
        role: 'viewer',
      } as TripMember);
      memberRepo.find.mockResolvedValueOnce([memberRow({})]);

      const roster = await service.listCollaborators(OTHER_ID, TRIP_ID);

      expect(roster.members[0]?.email).toBeNull();
      expect(roster.invites).toEqual([]);
      expect(inviteRepo.find).not.toHaveBeenCalled();
    });

    it('lets the owner change a member role and records activity', async () => {
      memberRepo.findOne
        .mockResolvedValueOnce({ role: 'owner' } as TripMember) // caller
        .mockResolvedValueOnce(memberRow({})) // target
        .mockResolvedValueOnce({ role: 'owner' } as TripMember); // roster re-read
      memberRepo.find.mockResolvedValueOnce([]);

      await service.updateMemberRole(OWNER_ID, TRIP_ID, OTHER_ID, 'viewer');

      expect(memberRepo.update).toHaveBeenCalledWith(
        { id: 'm-x' },
        { role: 'viewer' },
      );
      expect(activity.recordSafe).toHaveBeenCalledWith(
        TRIP_ID,
        OWNER_ID,
        'member_role_changed',
        { member_user_id: OTHER_ID, role: 'viewer' },
      );
    });

    it('forbids non-owners from managing roles', async () => {
      memberRepo.findOne.mockResolvedValueOnce({
        role: 'editor',
      } as TripMember);
      await expect(
        service.updateMemberRole(OTHER_ID, TRIP_ID, OWNER_ID, 'viewer'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(memberRepo.update).not.toHaveBeenCalled();
    });

    it('refuses to change or remove the owner row', async () => {
      memberRepo.findOne
        .mockResolvedValueOnce({ role: 'owner' } as TripMember)
        .mockResolvedValueOnce(
          memberRow({
            user_id: '00000000-0000-0000-0000-000000000009',
            role: 'owner',
          }),
        );
      await expect(
        service.updateMemberRole(
          OWNER_ID,
          TRIP_ID,
          '00000000-0000-0000-0000-000000000009',
          'viewer',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('removes a member and records activity; contributions stay', async () => {
      memberRepo.findOne
        .mockResolvedValueOnce({ role: 'owner' } as TripMember)
        .mockResolvedValueOnce(memberRow({}));

      await service.removeMember(OWNER_ID, TRIP_ID, OTHER_ID);

      expect(memberRepo.delete).toHaveBeenCalledWith({ id: 'm-x' });
      // Live sockets are kicked from the trip room, not just future REST.
      expect(events.evictFromTrip).toHaveBeenCalledWith(TRIP_ID, OTHER_ID);
      expect(activity.recordSafe).toHaveBeenCalledWith(
        TRIP_ID,
        OWNER_ID,
        'member_removed',
        { member_user_id: OTHER_ID },
      );
    });

    it('revokes a pending invite (404 when already gone)', async () => {
      memberRepo.findOne.mockResolvedValueOnce({
        role: 'owner',
      } as TripMember);
      await service.revokeInvite(OWNER_ID, TRIP_ID, 'inv-1');
      expect(inviteRepo.delete).toHaveBeenCalledWith({
        id: 'inv-1',
        trip_id: TRIP_ID,
      });

      memberRepo.findOne.mockResolvedValueOnce({
        role: 'owner',
      } as TripMember);
      inviteRepo.delete.mockResolvedValueOnce({ affected: 0, raw: [] });
      await expect(
        service.revokeInvite(OWNER_ID, TRIP_ID, 'inv-gone'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('join with a personal invite code adopts its role and consumes the row', async () => {
      tripRepo.findOne.mockResolvedValueOnce(makeOwnedTrip());
      manager.findOne
        .mockResolvedValueOnce({
          id: 'inv-1',
          trip_id: TRIP_ID,
          email: 'eve@example.com',
          role: 'editor',
          invite_code: 'ZZZZYYYY',
        })
        .mockResolvedValueOnce(null);
      mockGetDetailReturns(makeJoinedTrip());

      await service.join(OTHER_ID, TRIP_ID, 'zzzzyyyy');

      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'editor' }),
      );
      expect(manager.delete).toHaveBeenCalledWith(TripInvite, { id: 'inv-1' });
    });
  });

  describe('join', () => {
    it('adds a member when a personal invite code matches', async () => {
      tripRepo.findOne.mockResolvedValueOnce(makeOwnedTrip()); // join lookup
      // Inside the claim transaction: locked invite lookup, then the
      // existing-membership check.
      manager.findOne
        .mockResolvedValueOnce({
          id: 'inv-1',
          trip_id: TRIP_ID,
          email: 'eve@example.com',
          role: 'viewer',
          invite_code: 'ABCDEFGH',
        })
        .mockResolvedValueOnce(null);
      mockGetDetailReturns(makeJoinedTrip()); // post-join detail

      const result = await service.join(OTHER_ID, TRIP_ID, 'abcdefgh');

      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          trip_id: TRIP_ID,
          user_id: OTHER_ID,
          role: 'viewer',
        }),
      );
      // The invite is consumed so the roster's pending row disappears.
      expect(manager.delete).toHaveBeenCalledWith(TripInvite, { id: 'inv-1' });
      expect(result.members).toHaveLength(2);
    });

    it('normalizes the invite code (case + whitespace)', async () => {
      tripRepo.findOne.mockResolvedValueOnce(makeOwnedTrip());
      manager.findOne
        .mockResolvedValueOnce({
          id: 'inv-1',
          trip_id: TRIP_ID,
          email: 'eve@example.com',
          role: 'viewer',
          invite_code: 'ABCDEFGH',
        })
        .mockResolvedValueOnce(null);
      mockGetDetailReturns(makeJoinedTrip());

      await expect(
        service.join(OTHER_ID, TRIP_ID, '  abcdefgh  '),
      ).resolves.toBeDefined();
      // Lookup used the normalized code, under a claim lock.
      expect(manager.findOne).toHaveBeenCalledWith(TripInvite, {
        where: { trip_id: TRIP_ID, invite_code: 'ABCDEFGH' },
        lock: { mode: 'pessimistic_write' },
      });
    });

    it('is idempotent for an existing member (still consumes the invite)', async () => {
      tripRepo.findOne.mockResolvedValueOnce(makeOwnedTrip());
      manager.findOne
        .mockResolvedValueOnce({
          id: 'inv-1',
          trip_id: TRIP_ID,
          email: 'eve@example.com',
          role: 'viewer',
          invite_code: 'ABCDEFGH',
        })
        .mockResolvedValueOnce({ user_id: OWNER_ID });
      mockGetDetailReturns(makeOwnedTrip());

      await service.join(OWNER_ID, TRIP_ID, 'ABCDEFGH');

      expect(manager.save).not.toHaveBeenCalled();
      expect(manager.delete).toHaveBeenCalledWith(TripInvite, { id: 'inv-1' });
    });

    it('forbids joins with a wrong code', async () => {
      tripRepo.findOne.mockResolvedValueOnce(makeOwnedTrip());
      manager.findOne.mockResolvedValueOnce(null); // no invite claims it

      await expect(
        service.join(OTHER_ID, TRIP_ID, 'WRONG123'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('forbids joins for a missing trip without leaking existence', async () => {
      tripRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.join(OTHER_ID, TRIP_ID, 'ABCDEFGH'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('swallows a unique-violation race on duplicate insert', async () => {
      tripRepo.findOne.mockResolvedValueOnce(makeOwnedTrip());
      manager.findOne
        .mockResolvedValueOnce({
          id: 'inv-1',
          trip_id: TRIP_ID,
          email: 'eve@example.com',
          role: 'viewer',
          invite_code: 'ABCDEFGH',
        })
        .mockResolvedValueOnce(null);
      manager.save.mockRejectedValueOnce(
        Object.assign(new Error('duplicate key'), { code: '23505' }),
      );
      mockGetDetailReturns(makeJoinedTrip());

      await expect(
        service.join(OTHER_ID, TRIP_ID, 'ABCDEFGH'),
      ).resolves.toBeDefined();
    });

    it('rethrows non-unique-violation errors', async () => {
      tripRepo.findOne.mockResolvedValueOnce(makeOwnedTrip());
      manager.findOne
        .mockResolvedValueOnce({
          id: 'inv-1',
          trip_id: TRIP_ID,
          email: 'eve@example.com',
          role: 'viewer',
          invite_code: 'ABCDEFGH',
        })
        .mockResolvedValueOnce(null);
      manager.save.mockRejectedValueOnce(
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

    it('allows editors to mutate trip metadata', async () => {
      memberRepo.findOne.mockResolvedValueOnce({
        role: 'editor',
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

    it('US-37: assigns folder_id when the folder belongs to the trip owner', async () => {
      memberRepo.findOne.mockResolvedValueOnce({
        role: 'owner',
      } as TripMember);
      tripRepo.findOne.mockResolvedValueOnce({
        owner_id: OWNER_ID,
      } as Trip);
      folderRepo.findOne.mockResolvedValueOnce({
        id: 'fld-1',
        user_id: OWNER_ID,
      } as TripFolder);
      manager.findOne.mockResolvedValueOnce(makeOwnedTrip());
      mockGetDetailReturns(makeOwnedTrip({ folder_id: 'fld-1' }));

      await service.update(OWNER_ID, TRIP_ID, {
        folder_id: 'fld-1',
      });

      expect(folderRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'fld-1', user_id: OWNER_ID },
      });
      expect(manager.update).toHaveBeenCalledWith(
        Trip,
        { id: TRIP_ID },
        { folder_id: 'fld-1' },
      );
    });

    it('US-37: 404s a folder owned by a different rider (no info leak)', async () => {
      memberRepo.findOne.mockResolvedValueOnce({
        role: 'owner',
      } as TripMember);
      tripRepo.findOne.mockResolvedValueOnce({
        owner_id: OWNER_ID,
      } as Trip);
      // Service queries folderRepo with `user_id = trip.owner_id`, so a
      // foreign-user folder returns null and we expect the canonical
      // 404 — never 403 — to keep the endpoint a non-channel for
      // enumerating other riders' folder ids.
      folderRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.update(OWNER_ID, TRIP_ID, { folder_id: 'fld-other' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('US-37: clears folder_id (unfile) without checking folder ownership', async () => {
      // Passing `folder_id: null` is the "Move to Unfiled" path. We
      // shouldn't run the folder-ownership probe for null — there's
      // nothing to verify.
      memberRepo.findOne.mockResolvedValueOnce({
        role: 'owner',
      } as TripMember);
      manager.findOne.mockResolvedValueOnce(makeOwnedTrip());
      mockGetDetailReturns(makeOwnedTrip({ folder_id: null }));

      await service.update(OWNER_ID, TRIP_ID, { folder_id: null });

      expect(folderRepo.findOne).not.toHaveBeenCalled();
      expect(manager.update).toHaveBeenCalledWith(
        Trip,
        { id: TRIP_ID },
        { folder_id: null },
      );
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

    it('404s a non-owner (editors, viewers, non-members all collapse)', async () => {
      (tripRepo.delete as jest.Mock) = jest.fn();

      for (const role of ['editor', 'viewer'] as const) {
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
      const inviteCall = email.sendTripInvite.mock.calls[0];
      if (!inviteCall)
        throw new Error('expected sendTripInvite to have been called');
      const [to, ctx] = inviteCall;
      expect(to).toBe(RECIPIENT);
      expect(ctx).toMatchObject({
        inviterDisplayName: 'Adam',
        tripTitle: 'Big Italian Loop',
        message: 'Come ride with us!',
      });
      // The mail carries a PERSONAL invite code (minted per invite and
      // stored on the pending-invite row), not the trip-wide code — so
      // revoking this invite kills exactly this link.
      expect(ctx.inviteCode).toMatch(/^[A-Z0-9]{8}$/);
      expect(ctx.inviteCode).not.toBe('ABCDEFGH');
      expect(inviteRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          trip_id: TRIP_ID,
          email: RECIPIENT,
          role: 'editor',
          invite_code: ctx.inviteCode,
        }),
      );
      // Invite URL puts BOTH segments in the path so the companion
      // auth middleware's pathname-only callbackUrl can round-trip an
      // unauthenticated invitee through /login without losing the code.
      expect(ctx.joinUrl).toBe(
        `https://app.tarmoto.test/trips/join/${TRIP_ID}/${ctx.inviteCode}`,
      );

      expect(activity.recordSafe).toHaveBeenCalledWith(
        TRIP_ID,
        OWNER_ID,
        'member_invited',
        {
          recipient_email_domain: 'example.com',
          message_provided: true,
          role: 'editor',
        },
      );
    });

    it('editors can also send invites (owner+editor are privileged)', async () => {
      memberRepo.findOne.mockResolvedValueOnce({
        role: 'editor',
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
        {
          recipient_email_domain: 'example.com',
          message_provided: false,
          role: 'editor',
        },
      );
    });

    it('404s viewers and non-members without sending mail', async () => {
      // Viewer — non-privileged role.
      memberRepo.findOne.mockResolvedValueOnce({
        role: 'viewer',
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

  describe('saveManualRoute', () => {
    /** Shared enrichment stub — reused across most saveManualRoute tests. */
    function mockEnrichment() {
      enrichment.aggregate.mockResolvedValueOnce({
        avgQuality: 4,
        curvinessScore: 6,
        scenicScore: 3,
        elevationGain: 540,
        elevationLoss: 540,
        hazardCount: 0,
        surfaceMixMetres: {},
      });
    }

    it('403s viewers — route writes need editor access', async () => {
      memberRepo.findOne.mockResolvedValueOnce({
        trip_id: TRIP_ID,
        user_id: OTHER_ID,
        role: 'viewer',
      } as TripMember);

      await expect(
        service.saveManualRoute(OTHER_ID, TRIP_ID, { days: [] }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(transactionMock).not.toHaveBeenCalled();
    });

    it('re-routes from routing waypoints, persists day 1 + waypoints, broadcasts + returns detail', async () => {
      // membership gate passes (caller is a member)
      memberRepo.findOne.mockResolvedValueOnce({
        trip_id: TRIP_ID,
        user_id: OWNER_ID,
        role: 'owner',
      } as TripMember);

      // pessimistic lock read (Trip) first.
      manager.findOne.mockResolvedValueOnce({ id: TRIP_ID });
      // find existing days — one day exists whose suggestions will be decoupled.
      manager.find.mockResolvedValueOnce([{ id: 'd-1' }]);

      routingProvider.route.mockResolvedValueOnce({
        distance_km: 88.9,
        duration_min: 124,
        geometry: [
          { lat: 50.08, lng: 14.42 },
          { lat: 50.1, lng: 14.5 },
        ],
      });
      mockEnrichment();
      // post-save reload via getDetail
      mockGetDetailReturns(makeOwnedTrip());

      const result = await service.saveManualRoute(OWNER_ID, TRIP_ID, {
        days: [
          {
            dayNumber: 1,
            startLinked: false,
            waypoints: [
              { lat: 50.08, lng: 14.42, type: 'start' },
              { lat: 50.1, lng: 14.5, type: 'end' },
            ],
          },
        ],
        options: { preference: 'maximum_twisty' },
      });

      // Only start/via/end waypoints are passed to the router — WITH the
      // rider's road preference, so Save re-routes with the same costing
      // the approved live preview used.
      expect(routingProvider.route).toHaveBeenCalledWith(
        [
          { lat: 50.08, lng: 14.42 },
          { lat: 50.1, lng: 14.5 },
        ],
        expect.objectContaining({
          avoidHighways: undefined,
          avoidTolls: undefined,
          preference: 'maximum_twisty',
        }),
      );
      expect(enrichment.aggregate).toHaveBeenCalled();
      // transaction ran
      expect(transactionMock).toHaveBeenCalledTimes(1);
      // all existing-day suggestions NULLed before the delete (In operator).
      expect(manager.update).toHaveBeenCalledWith(
        TripSuggestion,
        { trip_day_id: In(['d-1']) },
        { trip_day_id: null },
      );
      // day 1 persisted with the server-side geometry
      const dayBodies = manager.create.mock.calls
        .map(([, body]) => body as Record<string, unknown>)
        .filter((b) => 'route_geom' in b);
      expect(dayBodies).toHaveLength(1);
      expect(dayBodies[0]).toMatchObject({
        day_number: 1,
        distance_km: 88.9,
        estimated_time: '124 minutes',
        elevation_gain: 540,
        elevation_loss: 540,
      });
      const geom = dayBodies[0].route_geom as {
        type: string;
        coordinates: number[][];
      };
      expect(geom.type).toBe('LineString');
      expect(geom.coordinates[0]).toEqual([14.42, 50.08]);
      // waypoints persisted
      const wpBodies = manager.create.mock.calls
        .map(([, body]) => body as Record<string, unknown>)
        .filter((b) => 'waypoint_type' in b);
      expect(wpBodies).toHaveLength(2);
      expect(wpBodies[0]).toMatchObject({
        sequence: 0,
        waypoint_type: 'start',
      });
      expect(wpBodies[1]).toMatchObject({ sequence: 1, waypoint_type: 'end' });
      // trip status, num_days + updated_at are bumped together
      expect(manager.update).toHaveBeenCalledWith(
        Trip,
        { id: TRIP_ID },
        expect.objectContaining({
          status: 'planned',
          num_days: 1,
          updated_at: expect.any(Date),
        }),
      );
      // broadcast to collaborators (Fix 4b)
      expect(events.emitToTrip).toHaveBeenCalledWith(
        TRIP_ID,
        'trip:updated',
        expect.objectContaining({ id: TRIP_ID }),
      );
      // Audit trail recorded for the route save (mirrors import/update/generate).
      expect(activity.recordSafe).toHaveBeenCalledWith(
        TRIP_ID,
        OWNER_ID,
        'trip_updated',
        expect.objectContaining({ fields: ['manual_route'] }),
      );
      expect(result.id).toBe(TRIP_ID);
    });

    it('routes only from start/via/end waypoints but persists all stops', async () => {
      // A save that includes a fuel stop: the router sees only start+end,
      // but all three waypoints (start, fuel, end) are persisted (Fix 5).
      memberRepo.findOne.mockResolvedValueOnce({
        trip_id: TRIP_ID,
        user_id: OWNER_ID,
        role: 'owner',
      } as TripMember);

      // pessimistic lock read (Trip) first.
      manager.findOne.mockResolvedValueOnce({ id: TRIP_ID });
      // find existing days — one day exists.
      manager.find.mockResolvedValueOnce([{ id: 'd-1' }]);

      routingProvider.route.mockResolvedValueOnce({
        distance_km: 120,
        duration_min: 90,
        geometry: [
          { lat: 46.5, lng: 10.5 },
          { lat: 46.6, lng: 10.6 },
        ],
      });
      mockEnrichment();
      mockGetDetailReturns(makeOwnedTrip());

      await service.saveManualRoute(OWNER_ID, TRIP_ID, {
        days: [
          {
            dayNumber: 1,
            startLinked: false,
            waypoints: [
              { lat: 46.5, lng: 10.5, name: 'Bormio', type: 'start' },
              { lat: 46.55, lng: 10.55, name: 'Fuel stop', type: 'fuel' },
              { lat: 46.6, lng: 10.6, name: 'Prato', type: 'end' },
            ],
          },
        ],
      });

      // Router called with only start+end — NOT the fuel stop.
      expect(routingProvider.route).toHaveBeenCalledWith(
        [
          { lat: 46.5, lng: 10.5 },
          { lat: 46.6, lng: 10.6 },
        ],
        expect.anything(),
      );

      // All 3 waypoints persisted (start, fuel, end).
      const wpBodies = manager.create.mock.calls
        .map(([, body]) => body as Record<string, unknown>)
        .filter((b) => 'waypoint_type' in b);
      expect(wpBodies).toHaveLength(3);
      expect(wpBodies[0]).toMatchObject({
        sequence: 0,
        waypoint_type: 'start',
      });
      expect(wpBodies[1]).toMatchObject({ sequence: 1, waypoint_type: 'fuel' });
      expect(wpBodies[2]).toMatchObject({ sequence: 2, waypoint_type: 'end' });
    });

    it('routes leg by leg when leg_preferences is present and merges the result', async () => {
      memberRepo.findOne.mockResolvedValueOnce({
        trip_id: TRIP_ID,
        user_id: OWNER_ID,
        role: 'owner',
      } as TripMember);
      manager.findOne.mockResolvedValueOnce({ id: TRIP_ID });
      manager.find.mockResolvedValueOnce([{ id: 'd-1' }]);

      routingProvider.route
        .mockResolvedValueOnce({
          distance_km: 40,
          duration_min: 30,
          geometry: [
            { lat: 50.0, lng: 14.0 },
            { lat: 50.1, lng: 14.1 },
          ],
        })
        .mockResolvedValueOnce({
          distance_km: 60,
          duration_min: 55,
          geometry: [
            { lat: 50.1, lng: 14.1 },
            { lat: 50.2, lng: 14.2 },
          ],
        });
      mockEnrichment();
      mockGetDetailReturns(makeOwnedTrip());

      await service.saveManualRoute(OWNER_ID, TRIP_ID, {
        days: [
          {
            dayNumber: 1,
            startLinked: false,
            waypoints: [
              { lat: 50.0, lng: 14.0, type: 'start' },
              { lat: 50.1, lng: 14.1, type: 'via' },
              { lat: 50.2, lng: 14.2, type: 'end' },
            ],
            leg_preferences: ['direct', 'maximum_twisty'],
          },
        ],
        options: { preference: 'direct' },
      });

      // One router call PER LEG, each with its own preference — the same
      // requests the live preview used.
      expect(routingProvider.route).toHaveBeenCalledTimes(2);
      expect(routingProvider.route).toHaveBeenNthCalledWith(
        1,
        [
          { lat: 50.0, lng: 14.0 },
          { lat: 50.1, lng: 14.1 },
        ],
        expect.objectContaining({ preference: 'direct' }),
      );
      expect(routingProvider.route).toHaveBeenNthCalledWith(
        2,
        [
          { lat: 50.1, lng: 14.1 },
          { lat: 50.2, lng: 14.2 },
        ],
        expect.objectContaining({ preference: 'maximum_twisty' }),
      );

      // Merged geometry drops the duplicated boundary vertex and the day
      // row carries the summed distance.
      const [geometry] = enrichment.aggregate.mock.calls[0]! as [
        Array<{ lat: number; lng: number }>,
      ];
      expect(geometry).toEqual([
        { lat: 50.0, lng: 14.0 },
        { lat: 50.1, lng: 14.1 },
        { lat: 50.2, lng: 14.2 },
      ]);
      const dayBodies = manager.create.mock.calls
        .map(([, body]) => body as Record<string, unknown>)
        .filter((b) => 'distance_km' in b);
      expect(dayBodies[0]).toMatchObject({
        distance_km: 100,
        // Persisted WITH the day so the planner re-seeds them on reload.
        leg_preferences: ['direct', 'maximum_twisty'],
      });
    });

    it('400s when leg_preferences length does not match the routing legs', async () => {
      memberRepo.findOne.mockResolvedValueOnce({
        trip_id: TRIP_ID,
        user_id: OWNER_ID,
        role: 'owner',
      } as TripMember);

      await expect(
        service.saveManualRoute(OWNER_ID, TRIP_ID, {
          days: [
            {
              dayNumber: 1,
              startLinked: false,
              waypoints: [
                { lat: 50.0, lng: 14.0, type: 'start' },
                { lat: 50.2, lng: 14.2, type: 'end' },
              ],
              // 2 routing waypoints = 1 leg, but 2 preferences supplied.
              leg_preferences: ['direct', 'maximum_twisty'],
            },
          ],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(routingProvider.route).not.toHaveBeenCalled();
    });

    it('decouples all existing-day suggestions via In() before replacing all days', async () => {
      // On a multi-day trip, saving all days must decouple suggestions for
      // every existing day before deleting them so in-flight collaboration
      // suggestions are not permanently lost to the cascade.
      memberRepo.findOne.mockResolvedValueOnce({
        trip_id: TRIP_ID,
        user_id: OWNER_ID,
        role: 'owner',
      } as TripMember);

      const DAY1_ID = 'dd-day1-0001';
      const DAY2_ID = 'dd-day2-0002';
      // pessimistic lock read (Trip) first.
      manager.findOne.mockResolvedValueOnce({ id: TRIP_ID });
      // Two existing days are returned by manager.find.
      manager.find.mockResolvedValueOnce([{ id: DAY1_ID }, { id: DAY2_ID }]);

      routingProvider.route.mockResolvedValueOnce({
        distance_km: 88.9,
        duration_min: 90,
        geometry: [
          { lat: 46.5, lng: 10.5 },
          { lat: 46.6, lng: 10.6 },
        ],
      });
      mockEnrichment();
      mockGetDetailReturns(makeOwnedTrip());

      await service.saveManualRoute(OWNER_ID, TRIP_ID, {
        days: [
          {
            dayNumber: 1,
            startLinked: false,
            waypoints: [
              { lat: 46.5, lng: 10.5, type: 'start' },
              { lat: 46.6, lng: 10.6, type: 'end' },
            ],
          },
        ],
      });

      // Suggestions for BOTH existing days are NULLed in one In() call.
      expect(manager.update).toHaveBeenCalledWith(
        TripSuggestion,
        { trip_day_id: In([DAY1_ID, DAY2_ID]) },
        { trip_day_id: null },
      );
      // All days deleted in one call (not day-1-only).
      expect(manager.delete).toHaveBeenCalledWith(TripDay, {
        trip_id: TRIP_ID,
      });
    });

    it('rejects a non-member with NotFoundException (404)', async () => {
      memberRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.saveManualRoute(OTHER_ID, TRIP_ID, {
          days: [
            {
              dayNumber: 1,
              startLinked: false,
              waypoints: [
                { lat: 0, lng: 0, type: 'start' },
                { lat: 1, lng: 1, type: 'end' },
              ],
            },
          ],
        }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(routingProvider.route).not.toHaveBeenCalled();
      expect(transactionMock).not.toHaveBeenCalled();
    });

    it('throws BadGatewayException when the routing provider returns null', async () => {
      memberRepo.findOne.mockResolvedValueOnce({
        trip_id: TRIP_ID,
        user_id: OWNER_ID,
        role: 'owner',
      } as TripMember);
      routingProvider.route.mockResolvedValueOnce(null);

      await expect(
        service.saveManualRoute(OWNER_ID, TRIP_ID, {
          days: [
            {
              dayNumber: 1,
              startLinked: false,
              waypoints: [
                { lat: 0, lng: 0, type: 'start' },
                { lat: 1, lng: 1, type: 'end' },
              ],
            },
          ],
        }),
      ).rejects.toBeInstanceOf(BadGatewayException);

      expect(transactionMock).not.toHaveBeenCalled();
    });

    it('rejects a save with no end waypoint (start + via) with 400', async () => {
      memberRepo.findOne.mockResolvedValueOnce({
        trip_id: TRIP_ID,
        user_id: OWNER_ID,
        role: 'owner',
      } as TripMember);

      await expect(
        service.saveManualRoute(OWNER_ID, TRIP_ID, {
          days: [
            {
              dayNumber: 1,
              startLinked: false,
              waypoints: [
                { lat: 0, lng: 0, type: 'start' },
                { lat: 1, lng: 1, type: 'via' },
              ],
            },
          ],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      // Validated before any routing/transaction work.
      expect(routingProvider.route).not.toHaveBeenCalled();
      expect(transactionMock).not.toHaveBeenCalled();
    });

    it('rejects a save with duplicate start/end waypoints with 400', async () => {
      memberRepo.findOne.mockResolvedValueOnce({
        trip_id: TRIP_ID,
        user_id: OWNER_ID,
        role: 'owner',
      } as TripMember);

      await expect(
        service.saveManualRoute(OWNER_ID, TRIP_ID, {
          days: [
            {
              dayNumber: 1,
              startLinked: false,
              waypoints: [
                { lat: 0, lng: 0, type: 'start' },
                { lat: 1, lng: 1, type: 'start' },
                { lat: 2, lng: 2, type: 'end' },
              ],
            },
          ],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(routingProvider.route).not.toHaveBeenCalled();
      expect(transactionMock).not.toHaveBeenCalled();
    });

    it('rejects a save whose routing waypoints are out of order (end before start) with 400', async () => {
      memberRepo.findOne.mockResolvedValueOnce({
        trip_id: TRIP_ID,
        user_id: OWNER_ID,
        role: 'owner',
      } as TripMember);

      await expect(
        service.saveManualRoute(OWNER_ID, TRIP_ID, {
          days: [
            {
              dayNumber: 1,
              startLinked: false,
              waypoints: [
                { lat: 1, lng: 1, type: 'end' },
                { lat: 0, lng: 0, type: 'start' },
              ],
            },
          ],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(routingProvider.route).not.toHaveBeenCalled();
      expect(transactionMock).not.toHaveBeenCalled();
    });

    it('saves a two-day route, routing + persisting each day with start_linked', async () => {
      memberRepo.findOne.mockResolvedValueOnce({
        trip_id: TRIP_ID,
        user_id: OWNER_ID,
        role: 'owner',
      } as TripMember);

      routingProvider.route
        .mockResolvedValueOnce({
          geometry: [
            { lat: 0, lng: 0 },
            { lat: 1, lng: 1 },
          ],
          distance_km: 10,
          duration_min: 20,
        })
        .mockResolvedValueOnce({
          geometry: [
            { lat: 1, lng: 1 },
            { lat: 2, lng: 2 },
          ],
          distance_km: 12,
          duration_min: 24,
        });

      // Enrich called twice (once per day).
      enrichment.aggregate
        .mockResolvedValueOnce({
          avgQuality: 4,
          curvinessScore: 6,
          scenicScore: 3,
          elevationGain: 100,
          elevationLoss: 80,
          hazardCount: 0,
          surfaceMixMetres: {},
        })
        .mockResolvedValueOnce({
          avgQuality: 3,
          curvinessScore: 5,
          scenicScore: 4,
          elevationGain: 200,
          elevationLoss: 150,
          hazardCount: 0,
          surfaceMixMetres: {},
        });

      // Transaction mocks: lock, find existing days (none), then two day saves.
      manager.findOne.mockResolvedValueOnce({ id: TRIP_ID });
      manager.find.mockResolvedValueOnce([]); // no existing days to decouple
      // save() returns a row with a stable id per call so waypoints get the right trip_day_id.
      manager.save
        .mockResolvedValueOnce({
          id: 'new-day-1',
          trip_id: TRIP_ID,
          day_number: 1,
        })
        .mockResolvedValueOnce([]) // day-1 waypoints
        .mockResolvedValueOnce({
          id: 'new-day-2',
          trip_id: TRIP_ID,
          day_number: 2,
        })
        .mockResolvedValueOnce([]); // day-2 waypoints

      mockGetDetailReturns(makeOwnedTrip());

      await service.saveManualRoute(OWNER_ID, TRIP_ID, {
        days: [
          {
            dayNumber: 1,
            startLinked: false,
            waypoints: [
              { lat: 0, lng: 0, type: 'start' },
              { lat: 1, lng: 1, type: 'end' },
            ],
          },
          {
            dayNumber: 2,
            startLinked: true,
            waypoints: [
              { lat: 1, lng: 1, type: 'start' },
              { lat: 2, lng: 2, type: 'end' },
            ],
          },
        ],
      });

      // Routing provider called once per day.
      expect(routingProvider.route).toHaveBeenCalledTimes(2);

      // Two TripDay rows created.
      const dayBodies = manager.create.mock.calls
        .map(([, body]) => body as Record<string, unknown>)
        .filter((b) => 'route_geom' in b);
      expect(dayBodies).toHaveLength(2);

      // Day 1: start_linked false, correct geometry.
      expect(dayBodies[0]).toMatchObject({
        day_number: 1,
        start_linked: false,
        distance_km: 10,
        estimated_time: '20 minutes',
      });

      // Day 2: start_linked true.
      expect(dayBodies[1]).toMatchObject({
        day_number: 2,
        start_linked: true,
        distance_km: 12,
        estimated_time: '24 minutes',
      });

      // Trip update includes num_days: 2.
      expect(manager.update).toHaveBeenCalledWith(
        Trip,
        { id: TRIP_ID },
        expect.objectContaining({ status: 'planned', num_days: 2 }),
      );
    });

    it('normalizes start_linked: clears a day-1 link and a successor whose start is not on the previous end', async () => {
      memberRepo.findOne.mockResolvedValueOnce({
        trip_id: TRIP_ID,
        user_id: OWNER_ID,
        role: 'owner',
      } as TripMember);
      routingProvider.route
        .mockResolvedValueOnce({
          geometry: [
            { lat: 0, lng: 0 },
            { lat: 1, lng: 1 },
          ],
          distance_km: 10,
          duration_min: 20,
        })
        .mockResolvedValueOnce({
          geometry: [
            { lat: 5, lng: 5 },
            { lat: 6, lng: 6 },
          ],
          distance_km: 12,
          duration_min: 24,
        });
      enrichment.aggregate
        .mockResolvedValueOnce({
          avgQuality: 4,
          curvinessScore: 6,
          scenicScore: 3,
          elevationGain: 100,
          elevationLoss: 80,
          hazardCount: 0,
          surfaceMixMetres: {},
        })
        .mockResolvedValueOnce({
          avgQuality: 3,
          curvinessScore: 5,
          scenicScore: 4,
          elevationGain: 200,
          elevationLoss: 150,
          hazardCount: 0,
          surfaceMixMetres: {},
        });
      manager.findOne.mockResolvedValueOnce({ id: TRIP_ID });
      manager.find.mockResolvedValueOnce([]);
      manager.save
        .mockResolvedValueOnce({ id: 'd1', trip_id: TRIP_ID, day_number: 1 })
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce({ id: 'd2', trip_id: TRIP_ID, day_number: 2 })
        .mockResolvedValueOnce([]);
      mockGetDetailReturns(makeOwnedTrip());

      await service.saveManualRoute(OWNER_ID, TRIP_ID, {
        days: [
          // Day 1 with an impossible startLinked:true → normalized to false.
          {
            dayNumber: 1,
            startLinked: true,
            waypoints: [
              { lat: 0, lng: 0, type: 'start' },
              { lat: 1, lng: 1, type: 'end' },
            ],
          },
          // Day 2 linked, but its start (5,5) is NOT day 1's end (1,1) → false.
          {
            dayNumber: 2,
            startLinked: true,
            waypoints: [
              { lat: 5, lng: 5, type: 'start' },
              { lat: 6, lng: 6, type: 'end' },
            ],
          },
        ],
      });

      const dayBodies = manager.create.mock.calls
        .map(([, body]) => body as Record<string, unknown>)
        .filter((b) => 'route_geom' in b);
      expect(dayBodies[0].start_linked).toBe(false); // day 1 is never linked
      expect(dayBodies[1].start_linked).toBe(false); // start not on previous end
    });

    it('persists each day title from the save payload (follows renumbering)', async () => {
      memberRepo.findOne.mockResolvedValueOnce({
        trip_id: TRIP_ID,
        user_id: OWNER_ID,
        role: 'owner',
      } as TripMember);
      routingProvider.route
        .mockResolvedValueOnce({
          geometry: [
            { lat: 0, lng: 0 },
            { lat: 1, lng: 1 },
          ],
          distance_km: 10,
          duration_min: 20,
        })
        .mockResolvedValueOnce({
          geometry: [
            { lat: 1, lng: 1 },
            { lat: 2, lng: 2 },
          ],
          distance_km: 12,
          duration_min: 24,
        });
      enrichment.aggregate
        .mockResolvedValueOnce({
          avgQuality: 4,
          curvinessScore: 6,
          scenicScore: 3,
          elevationGain: 100,
          elevationLoss: 80,
          hazardCount: 0,
          surfaceMixMetres: {},
        })
        .mockResolvedValueOnce({
          avgQuality: 3,
          curvinessScore: 5,
          scenicScore: 4,
          elevationGain: 200,
          elevationLoss: 150,
          hazardCount: 0,
          surfaceMixMetres: {},
        });
      manager.findOne.mockResolvedValueOnce({ id: TRIP_ID });
      // Existing days carry titles (e.g. from generation/import).
      manager.find.mockResolvedValueOnce([
        { id: 'old-1', day_number: 1, title: 'Leg A' },
        { id: 'old-2', day_number: 2, title: 'Leg B' },
      ]);
      manager.save
        .mockResolvedValueOnce({ id: 'd1', trip_id: TRIP_ID, day_number: 1 })
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce({ id: 'd2', trip_id: TRIP_ID, day_number: 2 })
        .mockResolvedValueOnce([]);
      mockGetDetailReturns(makeOwnedTrip());

      await service.saveManualRoute(OWNER_ID, TRIP_ID, {
        days: [
          {
            dayNumber: 1,
            title: 'Leg A',
            startLinked: false,
            waypoints: [
              { lat: 0, lng: 0, type: 'start' },
              { lat: 1, lng: 1, type: 'end' },
            ],
          },
          {
            dayNumber: 2,
            title: 'Leg B',
            startLinked: true,
            waypoints: [
              { lat: 1, lng: 1, type: 'start' },
              { lat: 2, lng: 2, type: 'end' },
            ],
          },
        ],
      });

      const dayBodies = manager.create.mock.calls
        .map(([, body]) => body as Record<string, unknown>)
        .filter((b) => 'route_geom' in b);
      expect(dayBodies[0].title).toBe('Leg A'); // from the payload, not day_number
      expect(dayBodies[1].title).toBe('Leg B');
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

    it('maps start_linked from the day entity (defaulting false)', async () => {
      const trip = makeOwnedTrip({
        days: [
          {
            id: 'd-1',
            day_number: 1,
            title: null,
            distance_km: 0,
            avg_quality: 0,
            elevation_gain: 0,
            estimated_time: null,
            route_geom: null,
            start_linked: false,
            waypoints: [],
          } as never,
          {
            id: 'd-2',
            day_number: 2,
            title: null,
            distance_km: 0,
            avg_quality: 0,
            elevation_gain: 0,
            estimated_time: null,
            route_geom: null,
            start_linked: true,
            waypoints: [],
          } as never,
        ],
      });
      mockGetDetailReturns(trip);

      const detail = await service.getDetail(OWNER_ID, TRIP_ID);
      expect(detail.days[0]?.start_linked).toBe(false);
      expect(detail.days[1]?.start_linked).toBe(true);
    });
  });
});
