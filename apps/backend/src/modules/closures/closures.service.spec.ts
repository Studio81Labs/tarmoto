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

  const mockQb = {
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([SAMPLE_CLOSURE]),
  };

  beforeEach(async () => {
    mockQb.andWhere.mockClear();
    mockQb.orderBy.mockClear();
    mockQb.getMany.mockReset().mockResolvedValue([SAMPLE_CLOSURE]);

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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClosuresService,
        { provide: getRepositoryToken(RoadClosure), useValue: repo },
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

    it('excludes deactivated feed rows on the default (live) path', async () => {
      await service.list({});
      expect(mockQb.andWhere).toHaveBeenCalledWith('c.is_active = true');
    });

    it('does not apply the is_active filter when include_past is true', async () => {
      await service.list({ include_past: true });
      const calls = mockQb.andWhere.mock.calls as [string, unknown][];
      expect(calls.some((c) => /is_active = true/.test(c[0]))).toBe(false);
      // ...but undecoded rows are still excluded even in history view.
      expect(calls.some((c) => /geom IS NOT NULL/.test(c[0]))).toBe(true);
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
      expect(dto.geometry).toEqual([
        { lng: 17.12, lat: 50.11 },
        { lng: 17.13, lat: 50.12 },
      ]);
    });

    it('serialises a stored detour LineString into the DTO, null otherwise', async () => {
      mockQb.getMany.mockResolvedValueOnce([SAMPLE_CLOSURE, ROADWORKS_CLOSURE]);
      const [plain, roadworks] = await service.list({});
      expect(plain.detour).toBeNull();
      expect(roadworks.detour).toEqual([
        { lng: 17.1, lat: 50.1 },
        { lng: 17.15, lat: 50.15 },
        { lng: 17.2, lat: 50.2 },
      ]);
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
      mockQb.getMany.mockResolvedValueOnce([SAMPLE_CLOSURE]);

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
        lng0: 17.1,
        lat0: 50.1,
        lng1: 17.2,
        lat1: 50.2,
        lng2: 17.3,
        lat2: 50.3,
      });
    });

    it('defaults the buffer to 100 m', async () => {
      mockQb.getMany.mockResolvedValueOnce([]);
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
      mockQb.getMany.mockResolvedValueOnce([]);
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
      mockQb.getMany.mockResolvedValueOnce([]);
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
      mockQb.getMany.mockResolvedValueOnce([
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
      mockQb.getMany.mockResolvedValueOnce([
        ADVISORY_CLOSURE,
        SAMPLE_CLOSURE,
        PARTIAL_CLOSURE,
      ]);

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
      mockQb.getMany.mockResolvedValueOnce([]);
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
  });
});
