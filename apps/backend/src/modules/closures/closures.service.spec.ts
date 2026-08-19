import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ClosuresService } from './closures.service.js';
import { RoadClosure } from '../../entities/road-closure.entity.js';
import { FeatureResolver } from '../features/feature-resolver.service.js';

const SAMPLE_CLOSURE: RoadClosure = {
  id: 'closure-1',
  title: 'Rockfall on Road 44',
  reason: 'closure',
  severity: 'full',
  geom: {
    type: 'LineString',
    coordinates: [
      [17.12, 50.11],
      [17.13, 50.12],
    ],
  },
  detour_geom: null,
  country_code: 'CZ',
  region: 'Olomouc',
  starts_at: new Date('2026-04-20T00:00:00Z'),
  ends_at: new Date('2026-05-20T00:00:00Z'),
  notes: null,
  source: 'operator',
  created_by: 'user-1',
  external_id: null,
  last_seen_at: null,
  first_seen_at: null,
  is_active: true,
  validity_status: null,
  needs_location_decoding: false,
  raw_location_ref: null,
  created_at: new Date('2026-04-20T00:00:00Z'),
  updated_at: new Date('2026-04-20T00:00:00Z'),
};

const ROADWORKS_CLOSURE: RoadClosure = {
  ...SAMPLE_CLOSURE,
  id: 'closure-roadworks',
  title: 'Bridge resurfacing',
  reason: 'roadworks',
  severity: 'partial',
  detour_geom: {
    type: 'LineString',
    coordinates: [
      [17.1, 50.1],
      [17.15, 50.15],
      [17.2, 50.2],
    ],
  },
};

const ADVISORY_CLOSURE: RoadClosure = {
  ...SAMPLE_CLOSURE,
  id: 'closure-2',
  title: 'Gravel on shoulder',
  reason: 'other',
  severity: 'advisory',
};

const PARTIAL_CLOSURE: RoadClosure = {
  ...SAMPLE_CLOSURE,
  id: 'closure-3',
  title: 'Single-lane works',
  reason: 'roadworks',
  severity: 'partial',
};

describe('ClosuresService', () => {
  let service: ClosuresService;
  let repo: Partial<jest.Mocked<Repository<RoadClosure>>>;
  let featureResolver: jest.Mocked<
    Pick<FeatureResolver, 'isSystemSwitchEnabled'>
  >;

  const mockQb = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    setParameter: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([SAMPLE_CLOSURE]),
    getRawAndEntities: jest.fn().mockResolvedValue({
      entities: [SAMPLE_CLOSURE],
      raw: [{ full_count: '1', partial_count: '0', advisory_count: '0' }],
    }),
    getRawMany: jest.fn().mockResolvedValue([]),
  };

  const mockRouteResult = (
    entities: RoadClosure[],
    counts?: { full: number; partial: number; advisory: number },
  ) => {
    const totals = counts ?? {
      full: entities.filter((row) => row.severity === 'full').length,
      partial: entities.filter((row) => row.severity === 'partial').length,
      advisory: entities.filter((row) => row.severity === 'advisory').length,
    };
    mockQb.getRawAndEntities.mockResolvedValueOnce({
      entities,
      raw:
        entities.length > 0
          ? [
              {
                full_count: String(totals.full),
                partial_count: String(totals.partial),
                advisory_count: String(totals.advisory),
              },
            ]
          : [],
    });
  };

  beforeEach(async () => {
    mockQb.select.mockClear();
    mockQb.addSelect.mockClear();
    mockQb.where.mockClear();
    mockQb.andWhere.mockClear();
    mockQb.orderBy.mockClear();
    mockQb.addOrderBy.mockClear();
    mockQb.limit.mockClear();
    mockQb.setParameter.mockClear();
    mockQb.getMany.mockReset().mockResolvedValue([SAMPLE_CLOSURE]);
    mockQb.getRawAndEntities.mockReset().mockResolvedValue({
      entities: [SAMPLE_CLOSURE],
      raw: [{ full_count: '1', partial_count: '0', advisory_count: '0' }],
    });
    mockQb.getRawMany.mockReset().mockResolvedValue([]);

    repo = {
      createQueryBuilder: jest.fn().mockReturnValue(mockQb),
      findOne: jest.fn(),
      create: jest
        .fn()
        .mockImplementation(
          (data: Partial<RoadClosure>) => data as RoadClosure,
        ),
      save: jest.fn().mockImplementation((r: RoadClosure) =>
        Promise.resolve({
          ...SAMPLE_CLOSURE,
          ...r,
          id: r.id ?? 'closure-new',
          created_at: r.created_at ?? SAMPLE_CLOSURE.created_at,
          updated_at: new Date('2026-04-22T00:00:00Z'),
        }),
      ),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    // Defaults both switches ON so every pre-existing test below is
    // unaffected; the off-case tests set their own mock resolving `false`.
    featureResolver = {
      isSystemSwitchEnabled: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClosuresService,
        { provide: getRepositoryToken(RoadClosure), useValue: repo },
        { provide: FeatureResolver, useValue: featureResolver },
      ],
    }).compile();
    service = module.get(ClosuresService);
  });

  describe('list', () => {
    it('applies the active-on filter by default', async () => {
      await service.list({});
      const calls = mockQb.andWhere.mock.calls as [string, unknown][];
      // starts_at <= activeOn and ends_at IS NULL OR ends_at >= activeOn
      expect(calls.some((c) => /starts_at <= :activeOn/.test(c[0]))).toBe(true);
      expect(calls.some((c) => /ends_at IS NULL/.test(c[0]))).toBe(true);
    });

    it('skips the active-on filter when include_past is true', async () => {
      await service.list({ include_past: true });
      const calls = mockQb.andWhere.mock.calls as [string, unknown][];
      expect(calls.some((c) => /starts_at <= :activeOn/.test(c[0]))).toBe(
        false,
      );
    });

    it('always excludes undecoded (null-geometry) feed rows', async () => {
      await service.list({ include_past: true });
      expect(mockQb.andWhere).toHaveBeenCalledWith('c.geom IS NOT NULL');
    });

    it('prioritises full closures before applying the deterministic list cap', async () => {
      await service.list({ include_past: true });

      expect(mockQb.orderBy).toHaveBeenCalledWith(
        expect.stringContaining("WHEN 'full' THEN 0"),
        'ASC',
      );
      expect(mockQb.addOrderBy).toHaveBeenCalledWith('c.starts_at', 'DESC');
      expect(mockQb.limit).toHaveBeenCalledWith(500);
    });

    it('excludes deactivated feed rows on the default (live) path', async () => {
      await service.list({});
      expect(mockQb.andWhere).toHaveBeenCalledWith('c.is_active = true');
    });

    it('still excludes inactive feed rows when include_past is true', async () => {
      await service.list({ include_past: true });
      const calls = mockQb.andWhere.mock.calls as [string, unknown][];
      // include_past drops ONLY the time-window filter, not is_active /
      // geom — inactive feed history must not be exposed publicly.
      expect(calls.some((c) => /is_active = true/.test(c[0]))).toBe(true);
      expect(calls.some((c) => /geom IS NOT NULL/.test(c[0]))).toBe(true);
      expect(calls.some((c) => /starts_at <= :activeOn/.test(c[0]))).toBe(
        false,
      );
    });

    it('passes the parsed bbox into the spatial filter', async () => {
      await service.list({ bbox: '5,45,17,49' });
      expect(mockQb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('ST_Intersects'),
        { minLng: 5, minLat: 45, maxLng: 17, maxLat: 49 },
      );
    });

    it('rejects a malformed bbox', async () => {
      await expect(service.list({ bbox: 'not,a,bbox' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.list({ bbox: '5,9,5,9' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('filters by severity and reason when given', async () => {
      await service.list({ severity: 'full', reason: 'roadworks' });
      expect(mockQb.andWhere).toHaveBeenCalledWith('c.severity = :severity', {
        severity: 'full',
      });
      expect(mockQb.andWhere).toHaveBeenCalledWith('c.reason = :reason', {
        reason: 'roadworks',
      });
    });

    it('uses the supplied active_on timestamp instead of now', async () => {
      const when = '2026-12-01T00:00:00Z';
      await service.list({ active_on: when });
      const calls = mockQb.andWhere.mock.calls as [
        string,
        { activeOn: Date },
      ][];
      const call = calls.find((c) => /starts_at <= :activeOn/.test(c[0]));
      expect(call).toBeDefined();
      expect(call![1].activeOn.toISOString()).toBe(
        new Date(when).toISOString(),
      );
    });

    it('serialises the LineString to lat/lng points in the DTO', async () => {
      const [dto] = await service.list({});
      expect(dto!.geometry).toEqual([
        { lng: 17.12, lat: 50.11 },
        { lng: 17.13, lat: 50.12 },
      ]);
    });

    it('serialises a stored detour LineString into the DTO, null otherwise', async () => {
      mockQb.getMany.mockResolvedValueOnce([SAMPLE_CLOSURE, ROADWORKS_CLOSURE]);
      const [plain, roadworks] = await service.list({});
      expect(plain!.detour).toBeNull();
      expect(roadworks!.detour).toEqual([
        { lng: 17.1, lat: 50.1 },
        { lng: 17.15, lat: 50.15 },
        { lng: 17.2, lat: 50.2 },
      ]);
    });

    it('still returns operator/osm closures — hides only NAP (official) rows — when sys_nap_conditions is off', async () => {
      featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);
      // Default mockQb.getMany fixture (SAMPLE_CLOSURE) is source: 'operator'
      // — road_closures is mixed-source, so the switch must not zero it out.
      const [dto] = await service.list({});
      expect(dto!.source).toBe('operator');
      expect(mockQb.andWhere).toHaveBeenCalledWith("c.source != 'official'");
      expect(featureResolver.isSystemSwitchEnabled).toHaveBeenCalledWith(
        'sys_nap_conditions',
      );
    });
  });

  describe('getById', () => {
    it('returns the DTO when found', async () => {
      (repo.findOne as jest.Mock).mockResolvedValueOnce(SAMPLE_CLOSURE);
      const dto = await service.getById('closure-1');
      expect(dto.id).toBe('closure-1');
    });

    it('throws NotFound when missing', async () => {
      (repo.findOne as jest.Mock).mockResolvedValueOnce(null);
      await expect(service.getById('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('throws NotFound for an undecoded (null-geometry) feed row', async () => {
      (repo.findOne as jest.Mock).mockResolvedValueOnce({
        ...SAMPLE_CLOSURE,
        id: 'undecoded-1',
        source: 'official',
        external_id: 'ndic-123',
        geom: null,
        needs_location_decoding: true,
      });
      await expect(service.getById('undecoded-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('throws NotFound for a deactivated feed row (dropped from snapshot)', async () => {
      (repo.findOne as jest.Mock).mockResolvedValueOnce({
        ...SAMPLE_CLOSURE,
        id: 'inactive-1',
        source: 'official',
        external_id: 'ndic-456',
        is_active: false,
      });
      await expect(service.getById('inactive-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('404s a NAP-sourced (official) closure when sys_nap_conditions is off', async () => {
      featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);
      (repo.findOne as jest.Mock).mockResolvedValueOnce({
        ...SAMPLE_CLOSURE,
        source: 'official',
      });
      await expect(service.getById('closure-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(featureResolver.isSystemSwitchEnabled).toHaveBeenCalledWith(
        'sys_nap_conditions',
      );
    });

    it('still returns an operator-sourced closure when sys_nap_conditions is off', async () => {
      featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);
      (repo.findOne as jest.Mock).mockResolvedValueOnce({
        ...SAMPLE_CLOSURE,
        source: 'operator',
      });
      const dto = await service.getById('closure-1');
      expect(dto.source).toBe('operator');
    });
  });

  describe('checkRoute', () => {
    it('excludes undecoded and deactivated rows from the route check', async () => {
      await service.checkRoute({
        route: [
          { lat: 50.0, lng: 17.0 },
          { lat: 50.1, lng: 17.1 },
        ],
      });
      expect(mockQb.andWhere).toHaveBeenCalledWith('c.geom IS NOT NULL');
      expect(mockQb.andWhere).toHaveBeenCalledWith('c.is_active = true');
    });

    it('still counts operator/osm closures — hides only NAP (official) rows — when sys_nap_conditions is off', async () => {
      featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);
      mockRouteResult([SAMPLE_CLOSURE]); // source: 'operator'
      const result = await service.checkRoute({
        route: [
          { lat: 50.0, lng: 17.0 },
          { lat: 50.1, lng: 17.1 },
        ],
      });
      expect(result.closures).toHaveLength(1);
      expect(result.full_count).toBe(1);
      expect(mockQb.andWhere).toHaveBeenCalledWith("c.source != 'official'");
      expect(featureResolver.isSystemSwitchEnabled).toHaveBeenCalledWith(
        'sys_nap_conditions',
      );
    });

    it('still validates route length (400) even when sys_nap_conditions is off', async () => {
      featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);
      await expect(
        service.checkRoute({ route: [{ lat: 50, lng: 17 }] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('exclusionPolygons (#744)', () => {
    const bbox = { minLng: 16, minLat: 49, maxLng: 17, maxLat: 50 };
    const route = [
      { lat: 49.2, lng: 16.2 },
      { lat: 49.8, lng: 16.8 },
    ];

    it('queries only active full closures in the bbox, buffered', async () => {
      await service.exclusionPolygons(bbox, route);

      expect(mockQb.select).toHaveBeenCalledWith(
        expect.stringContaining('ST_Buffer(c.geom::geography'),
        'geojson',
      );
      expect(mockQb.where).toHaveBeenCalledWith('c.geom IS NOT NULL');
      expect(mockQb.andWhere).toHaveBeenCalledWith('c.is_active = true');
      expect(mockQb.andWhere).toHaveBeenCalledWith('c.severity = :full', {
        full: 'full',
      });
      expect(mockQb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('ST_Intersects'),
        bbox,
      );
      expect(mockQb.setParameter).toHaveBeenCalledWith('buffer', 25);
      expect(mockQb.setParameter).toHaveBeenCalledWith(
        'routeWkt',
        'LINESTRING(16.2 49.2,16.8 49.8)',
      );
      expect(mockQb.orderBy).toHaveBeenCalledWith(
        expect.stringContaining('ST_Distance'),
        'ASC',
      );
      expect(mockQb.addOrderBy).toHaveBeenCalledWith('c.starts_at', 'DESC');
      expect(mockQb.limit).toHaveBeenCalledWith(100);
    });

    it('returns the outer ring of each buffered Polygon', async () => {
      const ring: [number, number][] = [
        [16.6, 49.2],
        [16.7, 49.2],
        [16.7, 49.25],
        [16.6, 49.2],
      ];
      mockQb.getRawMany.mockResolvedValueOnce([
        { geojson: JSON.stringify({ type: 'Polygon', coordinates: [ring] }) },
      ]);
      const polygons = await service.exclusionPolygons(bbox, route);
      expect(polygons).toEqual([ring]);
    });

    it('flattens a MultiPolygon into one ring per part and skips null geom', async () => {
      const ringA: [number, number][] = [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ];
      const ringB: [number, number][] = [
        [2, 2],
        [3, 2],
        [3, 3],
        [2, 2],
      ];
      mockQb.getRawMany.mockResolvedValueOnce([
        {
          geojson: JSON.stringify({
            type: 'MultiPolygon',
            coordinates: [[ringA], [ringB]],
          }),
        },
        { geojson: null },
      ]);
      const polygons = await service.exclusionPolygons(bbox, route);
      expect(polygons).toEqual([ringA, ringB]);
    });

    it('returns [] when there are no full closures in the area', async () => {
      mockQb.getRawMany.mockResolvedValueOnce([]);
      expect(await service.exclusionPolygons(bbox, route)).toEqual([]);
    });

    it('still produces polygons for operator/osm full closures — hides only NAP (official) — when sys_nap_routing_avoidance is off', async () => {
      featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);
      const ring: [number, number][] = [
        [16.6, 49.2],
        [16.7, 49.2],
        [16.7, 49.25],
        [16.6, 49.2],
      ];
      mockQb.getRawMany.mockResolvedValueOnce([
        { geojson: JSON.stringify({ type: 'Polygon', coordinates: [ring] }) },
      ]);
      const polygons = await service.exclusionPolygons(bbox, route);
      expect(polygons).toEqual([ring]);
      expect(mockQb.andWhere).toHaveBeenCalledWith("c.source != 'official'");
      expect(featureResolver.isSystemSwitchEnabled).toHaveBeenCalledWith(
        'sys_nap_routing_avoidance',
      );
    });
  });

  describe('create', () => {
    it('persists a new closure with creator set', async () => {
      const dto = await service.create('user-1', {
        title: 'Test',
        reason: 'roadworks',
        severity: 'partial',
        geometry: [
          { lat: 50.0, lng: 17.0 },
          { lat: 50.1, lng: 17.1 },
        ],
        country_code: 'cz',
        starts_at: '2026-05-01T00:00:00Z',
        ends_at: '2026-05-10T00:00:00Z',
      });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Test',
          reason: 'roadworks',
          severity: 'partial',
          // Country code uppercased.
          country_code: 'CZ',
          source: 'operator',
          created_by: 'user-1',
          geom: {
            type: 'LineString',
            coordinates: [
              [17, 50],
              [17.1, 50.1],
            ],
          },
        }),
      );
      expect(dto.source).toBe('operator');
    });

    it('rejects ends_at earlier than starts_at', async () => {
      await expect(
        service.create('user-1', {
          title: 'Bad',
          reason: 'closure',
          severity: 'full',
          geometry: [
            { lat: 50, lng: 17 },
            { lat: 50.1, lng: 17.1 },
          ],
          country_code: 'CZ',
          starts_at: '2026-05-10T00:00:00Z',
          ends_at: '2026-05-01T00:00:00Z',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts an indefinite closure (ends_at omitted)', async () => {
      const dto = await service.create('user-1', {
        title: 'Open-ended',
        reason: 'seasonal',
        severity: 'full',
        geometry: [
          { lat: 50, lng: 17 },
          { lat: 50.1, lng: 17.1 },
        ],
        country_code: 'CZ',
        starts_at: '2026-11-01T00:00:00Z',
      });
      expect(dto.ends_at).toBeNull();
    });

    it('persists a detour polyline for a roadworks closure', async () => {
      await service.create('user-1', {
        title: 'Bridge works',
        reason: 'roadworks',
        severity: 'partial',
        geometry: [
          { lat: 50, lng: 17 },
          { lat: 50.1, lng: 17.1 },
        ],
        detour: [
          { lat: 50.05, lng: 17.05 },
          { lat: 50.06, lng: 17.06 },
        ],
        country_code: 'CZ',
        starts_at: '2026-05-01T00:00:00Z',
      });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          detour_geom: {
            type: 'LineString',
            coordinates: [
              [17.05, 50.05],
              [17.06, 50.06],
            ],
          },
        }),
      );
    });

    it('rejects a detour on a non-roadworks closure', async () => {
      await expect(
        service.create('user-1', {
          title: 'Not roadworks',
          reason: 'closure',
          severity: 'full',
          geometry: [
            { lat: 50, lng: 17 },
            { lat: 50.1, lng: 17.1 },
          ],
          detour: [
            { lat: 50.05, lng: 17.05 },
            { lat: 50.06, lng: 17.06 },
          ],
          country_code: 'CZ',
          starts_at: '2026-05-01T00:00:00Z',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('stores null detour_geom when no detour is supplied', async () => {
      await service.create('user-1', {
        title: 'Plain roadworks',
        reason: 'roadworks',
        severity: 'partial',
        geometry: [
          { lat: 50, lng: 17 },
          { lat: 50.1, lng: 17.1 },
        ],
        country_code: 'CZ',
        starts_at: '2026-05-01T00:00:00Z',
      });
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ detour_geom: null }),
      );
    });
  });

  describe('update', () => {
    it('applies only the fields present in the DTO', async () => {
      (repo.findOne as jest.Mock).mockResolvedValueOnce({ ...SAMPLE_CLOSURE });
      const dto = await service.update('closure-1', 'user-1', {
        title: 'Renamed',
      });
      expect(dto.title).toBe('Renamed');
      // severity / reason untouched
      expect(dto.severity).toBe('full');
      expect(dto.reason).toBe('closure');
    });

    it('clears ends_at when explicitly null', async () => {
      (repo.findOne as jest.Mock).mockResolvedValueOnce({ ...SAMPLE_CLOSURE });
      const dto = await service.update('closure-1', 'user-1', {
        ends_at: null,
      });
      expect(dto.ends_at).toBeNull();
    });

    it('rejects changes from a non-creator', async () => {
      (repo.findOne as jest.Mock).mockResolvedValueOnce({ ...SAMPLE_CLOSURE });
      await expect(
        service.update('closure-1', 'other-user', { title: 'Hack' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('throws NotFound when the closure is missing', async () => {
      (repo.findOne as jest.Mock).mockResolvedValueOnce(null);
      await expect(
        service.update('missing', 'user-1', { title: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects a window inversion caused by the update', async () => {
      (repo.findOne as jest.Mock).mockResolvedValueOnce({ ...SAMPLE_CLOSURE });
      await expect(
        service.update('closure-1', 'user-1', {
          starts_at: '2026-06-01T00:00:00Z',
          // existing ends_at is 2026-05-20 → would now be before starts_at
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('attaches a detour to an existing roadworks closure', async () => {
      (repo.findOne as jest.Mock).mockResolvedValueOnce({
        ...SAMPLE_CLOSURE,
        reason: 'roadworks',
      });
      const dto = await service.update('closure-1', 'user-1', {
        detour: [
          { lat: 50.05, lng: 17.05 },
          { lat: 50.06, lng: 17.06 },
        ],
      });
      expect(dto.detour).toEqual([
        { lng: 17.05, lat: 50.05 },
        { lng: 17.06, lat: 50.06 },
      ]);
    });

    it('clears a detour when explicitly null', async () => {
      (repo.findOne as jest.Mock).mockResolvedValueOnce({
        ...SAMPLE_CLOSURE,
        reason: 'roadworks',
        detour_geom: {
          type: 'LineString',
          coordinates: [
            [17.05, 50.05],
            [17.06, 50.06],
          ],
        },
      });
      const dto = await service.update('closure-1', 'user-1', {
        detour: null,
      });
      expect(dto.detour).toBeNull();
    });

    it('rejects a detour on a non-roadworks closure', async () => {
      (repo.findOne as jest.Mock).mockResolvedValueOnce({ ...SAMPLE_CLOSURE });
      await expect(
        service.update('closure-1', 'user-1', {
          detour: [
            { lat: 50.05, lng: 17.05 },
            { lat: 50.06, lng: 17.06 },
          ],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects reclassifying a detoured closure away from roadworks without clearing the detour', async () => {
      (repo.findOne as jest.Mock).mockResolvedValueOnce({
        ...SAMPLE_CLOSURE,
        reason: 'roadworks',
        detour_geom: {
          type: 'LineString',
          coordinates: [
            [17.05, 50.05],
            [17.06, 50.06],
          ],
        },
      });
      await expect(
        service.update('closure-1', 'user-1', { reason: 'closure' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('allows reclassifying when the caller also clears the detour', async () => {
      (repo.findOne as jest.Mock).mockResolvedValueOnce({
        ...SAMPLE_CLOSURE,
        reason: 'roadworks',
        detour_geom: {
          type: 'LineString',
          coordinates: [
            [17.05, 50.05],
            [17.06, 50.06],
          ],
        },
      });
      const dto = await service.update('closure-1', 'user-1', {
        reason: 'closure',
        detour: null,
      });
      expect(dto.reason).toBe('closure');
      expect(dto.detour).toBeNull();
    });
  });

  describe('remove', () => {
    it('deletes when called by the creator', async () => {
      (repo.findOne as jest.Mock).mockResolvedValueOnce({ ...SAMPLE_CLOSURE });
      await service.remove('closure-1', 'user-1');
      expect(repo.remove).toHaveBeenCalled();
    });

    it('rejects a non-creator', async () => {
      (repo.findOne as jest.Mock).mockResolvedValueOnce({ ...SAMPLE_CLOSURE });
      await expect(
        service.remove('closure-1', 'someone-else'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repo.remove).not.toHaveBeenCalled();
    });

    it('throws NotFound when missing', async () => {
      (repo.findOne as jest.Mock).mockResolvedValueOnce(null);
      await expect(service.remove('missing', 'user-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('checkRoute', () => {
    it('throws if the route has fewer than 2 points', async () => {
      await expect(
        service.checkRoute({ route: [{ lat: 50, lng: 17 }] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('passes each coordinate as its own named parameter', async () => {
      mockRouteResult([SAMPLE_CLOSURE]);

      await service.checkRoute({
        route: [
          { lat: 50.1, lng: 17.1 },
          { lat: 50.2, lng: 17.2 },
          { lat: 50.3, lng: 17.3 },
        ],
        buffer_m: 250,
      });

      const calls = mockQb.andWhere.mock.calls as [
        string,
        Record<string, unknown>,
      ][];
      const spatial = calls.find((c) => /ST_DWithin/.test(c[0]));
      expect(spatial).toBeDefined();
      expect(spatial![1]).toMatchObject({
        buffer: 250,
        routeLng0_0: 17.1,
        routeLat0_0: 50.1,
        routeLng0_1: 17.2,
        routeLat0_1: 50.2,
        routeLng0_2: 17.3,
        routeLat0_2: 50.3,
      });
      expect(typeof spatial![1].bufferLngDeg).toBe('number');
      expect(typeof spatial![1].bufferLatDeg).toBe('number');
      expect(mockQb.limit).toHaveBeenCalledWith(200);
      expect(mockQb.addSelect).toHaveBeenCalledWith(
        expect.stringContaining("c.severity = 'full'"),
        'full_count',
      );
      expect(mockQb.orderBy).toHaveBeenCalledWith(
        expect.stringContaining("WHEN 'full' THEN 0"),
        'ASC',
      );
      expect(mockQb.addOrderBy).toHaveBeenCalledWith('c.starts_at', 'DESC');
    });

    it('checks disconnected route chunks in one unique spatial query', async () => {
      mockRouteResult([SAMPLE_CLOSURE], {
        full: 1,
        partial: 0,
        advisory: 0,
      });

      const result = await service.checkRoute({
        route: [
          { lat: 50.1, lng: 17.1 },
          { lat: 50.2, lng: 17.2 },
        ],
        additional_routes: [
          {
            points: [
              { lat: 50.2, lng: 17.2 },
              { lat: 50.3, lng: 17.3 },
            ],
          },
        ],
      });

      expect(result.full_count).toBe(1);
      const calls = mockQb.andWhere.mock.calls as [
        string,
        Record<string, unknown>,
      ][];
      const prefilter = calls.find((call) =>
        String(call[0]).includes('ST_Expand'),
      );
      expect(prefilter?.[0]).toContain('ST_Collect');
      expect(prefilter?.[1]).toMatchObject({
        routeLng0_0: 17.1,
        routeLng1_1: 17.3,
      });
    });

    it('keeps the geometry prefilter conservative at high latitudes', async () => {
      mockRouteResult([]);
      await service.checkRoute({
        route: [
          { lat: 70, lng: 20 },
          { lat: 70.1, lng: 20.1 },
        ],
        buffer_m: 100,
      });

      const calls = mockQb.andWhere.mock.calls as [
        string,
        Record<string, unknown>,
      ][];
      const prefilter = calls.find((call) =>
        String(call[0]).includes('ST_Expand'),
      );
      const bufferLngDeg = prefilter?.[1].bufferLngDeg;
      expect(typeof bufferLngDeg).toBe('number');
      expect(bufferLngDeg as number).toBeGreaterThan(0.0025);
    });

    it('defaults the buffer to 100 m', async () => {
      mockRouteResult([]);
      await service.checkRoute({
        route: [
          { lat: 50, lng: 17 },
          { lat: 50.1, lng: 17.1 },
        ],
      });
      const calls = mockQb.andWhere.mock.calls as [
        string,
        Record<string, unknown>,
      ][];
      const spatial = calls.find((c) => /ST_DWithin/.test(c[0]));
      expect(spatial![1]).toMatchObject({ buffer: 100 });
    });

    it('applies the active-on window by default (now)', async () => {
      mockRouteResult([]);
      const before = Date.now();
      await service.checkRoute({
        route: [
          { lat: 50, lng: 17 },
          { lat: 50.1, lng: 17.1 },
        ],
      });
      const after = Date.now();

      const calls = mockQb.andWhere.mock.calls as [
        string,
        Record<string, unknown>,
      ][];
      expect(calls.some((c) => /starts_at <= :activeOn/.test(c[0]))).toBe(true);
      expect(calls.some((c) => /ends_at IS NULL/.test(c[0]))).toBe(true);

      const startsCall = calls.find((c) => /starts_at <= :activeOn/.test(c[0]));
      const activeOn = (startsCall![1] as { activeOn: Date }).activeOn;
      expect(activeOn).toBeInstanceOf(Date);
      // The default should be "now" — bracketed by the timestamps we
      // captured around the call.
      expect(activeOn.getTime()).toBeGreaterThanOrEqual(before);
      expect(activeOn.getTime()).toBeLessThanOrEqual(after);
    });

    it('uses the supplied active_on timestamp instead of now', async () => {
      mockRouteResult([]);
      const when = '2026-12-24T12:00:00Z';
      await service.checkRoute({
        route: [
          { lat: 50, lng: 17 },
          { lat: 50.1, lng: 17.1 },
        ],
        active_on: when,
      });
      const calls = mockQb.andWhere.mock.calls as [
        string,
        { activeOn: Date },
      ][];
      const startsCall = calls.find((c) => /starts_at <= :activeOn/.test(c[0]));
      expect(startsCall![1].activeOn.toISOString()).toBe(
        new Date(when).toISOString(),
      );
    });

    it('aggregates counts per severity', async () => {
      mockRouteResult([
        SAMPLE_CLOSURE, // full
        ADVISORY_CLOSURE, // advisory
        PARTIAL_CLOSURE, // partial
        { ...SAMPLE_CLOSURE, id: 'closure-4' }, // another full
      ]);

      const result = await service.checkRoute({
        route: [
          { lat: 50, lng: 17 },
          { lat: 50.1, lng: 17.1 },
        ],
      });

      expect(result.closures).toHaveLength(4);
      expect(result.full_count).toBe(2);
      expect(result.partial_count).toBe(1);
      expect(result.advisory_count).toBe(1);
    });

    it('orders closures by severity (full > partial > advisory)', async () => {
      // Intentionally out of order in the DB result.
      mockRouteResult([ADVISORY_CLOSURE, SAMPLE_CLOSURE, PARTIAL_CLOSURE]);

      const result = await service.checkRoute({
        route: [
          { lat: 50, lng: 17 },
          { lat: 50.1, lng: 17.1 },
        ],
      });

      expect(result.closures.map((c) => c.severity)).toEqual([
        'full',
        'partial',
        'advisory',
      ]);
    });

    it('returns zero counts when no closures match the route', async () => {
      mockRouteResult([]);
      const result = await service.checkRoute({
        route: [
          { lat: 50, lng: 17 },
          { lat: 50.1, lng: 17.1 },
        ],
      });
      expect(result.closures).toEqual([]);
      expect(result.full_count).toBe(0);
      expect(result.partial_count).toBe(0);
      expect(result.advisory_count).toBe(0);
    });

    it('reports severity totals from before the closure list cap', async () => {
      mockRouteResult([SAMPLE_CLOSURE, PARTIAL_CLOSURE], {
        full: 205,
        partial: 17,
        advisory: 3,
      });

      const result = await service.checkRoute({
        route: [
          { lat: 50, lng: 17 },
          { lat: 50.1, lng: 17.1 },
        ],
      });

      expect(result.closures).toHaveLength(2);
      expect(result.full_count).toBe(205);
      expect(result.partial_count).toBe(17);
      expect(result.advisory_count).toBe(3);
    });
  });
});
