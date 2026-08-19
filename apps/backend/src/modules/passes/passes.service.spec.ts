import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BadRequestException } from '@nestjs/common';
import { PassesService } from './passes.service.js';
import { MountainPass } from '../../entities/mountain-pass.entity.js';

const STELVIO: MountainPass = {
  id: 'pass-stelvio',
  name: 'Stelvio Pass',
  country_code: 'IT',
  region: 'Lombardy',
  location: { type: 'Point', coordinates: [10.454, 46.5285] },
  elevation_m: 2757,
  typical_open_month: 6,
  typical_close_month: 10,
  override_status: null,
  notes: null,
  last_updated: new Date('2026-04-18T00:00:00Z'),
};

const FORCED_CLOSED: MountainPass = {
  ...STELVIO,
  id: 'pass-forced',
  name: 'Forced Closed Pass',
  override_status: 'closed',
};

describe('PassesService', () => {
  let service: PassesService;
  let passRepo: Partial<jest.Mocked<Repository<MountainPass>>>;

  const mockQb = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    offset: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([STELVIO]),
    getRawAndEntities: jest.fn().mockResolvedValue({
      entities: [STELVIO],
      raw: [{ closed_count: '0', unknown_count: '0' }],
    }),
  };

  const mockRouteResult = (
    entities: MountainPass[],
    counts?: { closed: number; unknown: number },
  ) => {
    const month = 1;
    const totals = counts ?? {
      closed: entities.filter(
        (row) =>
          (row.override_status ??
            PassesService.statusFromSchedule(
              row.typical_open_month,
              row.typical_close_month,
              month,
            )) === 'closed',
      ).length,
      unknown: entities.filter(
        (row) =>
          (row.override_status ??
            PassesService.statusFromSchedule(
              row.typical_open_month,
              row.typical_close_month,
              month,
            )) === 'unknown',
      ).length,
    };
    mockQb.getRawAndEntities.mockResolvedValueOnce({
      entities,
      raw:
        entities.length > 0
          ? [
              {
                closed_count: String(totals.closed),
                unknown_count: String(totals.unknown),
              },
            ]
          : [],
    });
  };

  beforeEach(async () => {
    passRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(mockQb),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PassesService,
        { provide: getRepositoryToken(MountainPass), useValue: passRepo },
      ],
    }).compile();
    service = module.get<PassesService>(PassesService);
    jest.clearAllMocks();
    mockQb.getMany.mockResolvedValue([STELVIO]);
    mockQb.getRawAndEntities.mockResolvedValue({
      entities: [STELVIO],
      raw: [{ closed_count: '0', unknown_count: '0' }],
    });
  });

  describe('statusFromSchedule', () => {
    it('returns "open" inside a non-wrapping summer window', () => {
      expect(PassesService.statusFromSchedule(6, 10, 8)).toBe('open');
    });

    it('treats both endpoints of the window as open (inclusive)', () => {
      expect(PassesService.statusFromSchedule(6, 10, 6)).toBe('open');
      expect(PassesService.statusFromSchedule(6, 10, 10)).toBe('open');
    });

    it('returns "closed" outside a non-wrapping window', () => {
      expect(PassesService.statusFromSchedule(6, 10, 1)).toBe('closed');
      expect(PassesService.statusFromSchedule(6, 10, 11)).toBe('closed');
    });

    it('handles year-wrapping windows (Nov→Mar)', () => {
      expect(PassesService.statusFromSchedule(11, 3, 12)).toBe('open');
      expect(PassesService.statusFromSchedule(11, 3, 2)).toBe('open');
      expect(PassesService.statusFromSchedule(11, 3, 11)).toBe('open');
      expect(PassesService.statusFromSchedule(11, 3, 3)).toBe('open');
      expect(PassesService.statusFromSchedule(11, 3, 5)).toBe('closed');
    });

    it('returns "unknown" for non-integers or out-of-range months', () => {
      expect(PassesService.statusFromSchedule(0, 10, 5)).toBe('unknown');
      expect(PassesService.statusFromSchedule(6, 13, 5)).toBe('unknown');
      expect(PassesService.statusFromSchedule(6, 10, 0)).toBe('unknown');
      expect(PassesService.statusFromSchedule(6.5, 10, 8)).toBe('unknown');
    });
  });

  describe('list', () => {
    it('returns DTOs with derived status from current month', async () => {
      jest.spyOn(global.Date.prototype, 'getUTCMonth').mockReturnValueOnce(7); // August
      const result = await service.list();
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 'pass-stelvio',
        name: 'Stelvio Pass',
        lat: 46.5285,
        lng: 10.454,
        status: 'open',
        status_overridden: false,
      });
    });

    it('marks status closed in winter', async () => {
      jest.spyOn(global.Date.prototype, 'getUTCMonth').mockReturnValueOnce(0); // January
      const result = await service.list();
      expect(result[0].status).toBe('closed');
    });

    it('honours override_status over the schedule', async () => {
      mockQb.getMany.mockResolvedValueOnce([FORCED_CLOSED]);
      jest.spyOn(global.Date.prototype, 'getUTCMonth').mockReturnValueOnce(7); // August — would normally be open
      const result = await service.list();
      expect(result[0].status).toBe('closed');
      expect(result[0].status_overridden).toBe(true);
    });

    it('rejects malformed bbox', async () => {
      await expect(service.list('not,a,bbox')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.list('1,2,3')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.list('5,9,5,9')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('passes parsed bbox into the spatial filter', async () => {
      await service.list('5,45,17,49');
      expect(mockQb.where).toHaveBeenCalledWith(
        expect.stringContaining('ST_Intersects'),
        { minLng: 5, minLat: 45, maxLng: 17, maxLat: 49 },
      );
    });

    it('applies bounded pagination after deterministic name ordering', async () => {
      await service.list(undefined, undefined, 200, 400);

      expect(mockQb.orderBy).toHaveBeenCalledWith('p.name', 'ASC');
      expect(mockQb.addOrderBy).toHaveBeenCalledWith('p.id', 'ASC');
      expect(mockQb.limit).toHaveBeenCalledWith(200);
      expect(mockQb.offset).toHaveBeenCalledWith(400);
    });

    it('evaluates status for the supplied for_month instead of today', async () => {
      // Stelvio: open Jun..Oct. Ask for January explicitly — must be
      // closed even though "today" (mocked to August) would be open.
      jest.spyOn(global.Date.prototype, 'getUTCMonth').mockReturnValue(7);
      const result = await service.list(undefined, 1);
      expect(result[0].status).toBe('closed');
    });

    it('falls back to the current UTC month when for_month is undefined', async () => {
      jest.spyOn(global.Date.prototype, 'getUTCMonth').mockReturnValue(7); // August
      const result = await service.list();
      expect(result[0].status).toBe('open');
    });

    it('ignores an out-of-range for_month and falls back to current month', async () => {
      // Defence-in-depth: DTO validation normally catches 0 / 13, but the
      // service must not explode if an internal caller ever skips the DTO.
      jest.spyOn(global.Date.prototype, 'getUTCMonth').mockReturnValue(0); // January
      const result = await service.list(undefined, 13);
      expect(result[0].status).toBe('closed');
    });
  });

  describe('checkRoute', () => {
    it('throws if the route has fewer than 2 points', async () => {
      await expect(
        service.checkRoute({ route: [{ lat: 49, lng: 18 }] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('runs the spatial query and aggregates closed/unknown counts', async () => {
      mockRouteResult([STELVIO, FORCED_CLOSED], {
        closed: 2,
        unknown: 0,
      });
      jest.spyOn(global.Date.prototype, 'getUTCMonth').mockReturnValue(0); // January

      const result = await service.checkRoute({
        route: [
          { lat: 46.5, lng: 10.4 },
          { lat: 46.6, lng: 10.5 },
        ],
        buffer_m: 2000,
      });

      expect(result.passes).toHaveLength(2);
      // Stelvio in January = closed (not overridden); forced = closed (overridden)
      expect(result.closed_count).toBe(2);
      expect(result.unknown_count).toBe(0);
      // Each coordinate is passed as its own named parameter so TypeORM can
      // bind them safely — no string interpolation of user input.
      expect(mockQb.where).toHaveBeenCalledWith(
        expect.stringContaining('ST_Expand'),
        expect.objectContaining({
          buffer: 2000,
          routeLng0_0: 10.4,
          routeLat0_0: 46.5,
          routeLng0_1: 10.5,
          routeLat0_1: 46.6,
        }),
      );
      const whereParams = (mockQb.where.mock.calls as unknown[][])[0]?.[1] as
        Record<string, unknown> | undefined;
      expect(typeof whereParams?.bufferLngDeg).toBe('number');
      expect(typeof whereParams?.bufferLatDeg).toBe('number');
      expect(mockQb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('p.location::geography'),
        expect.any(Object),
      );
      expect(mockQb.orderBy).toHaveBeenCalledWith('p.elevation_m', 'DESC');
      expect(mockQb.limit).toHaveBeenCalledWith(200);
      expect(mockQb.addSelect).toHaveBeenCalledTimes(2);
      expect(mockQb.addSelect).toHaveBeenCalledWith(
        expect.stringContaining(':statusMonth'),
        'closed_count',
      );
    });

    it('checks disconnected route chunks in one unique spatial query', async () => {
      mockRouteResult([STELVIO], { closed: 1, unknown: 0 });

      const result = await service.checkRoute({
        route: [
          { lat: 46.5, lng: 10.4 },
          { lat: 46.6, lng: 10.5 },
        ],
        additional_routes: [
          {
            points: [
              { lat: 46.6, lng: 10.5 },
              { lat: 46.7, lng: 10.6 },
            ],
          },
        ],
        for_month: 1,
      });

      expect(result.closed_count).toBe(1);
      expect(mockQb.where).toHaveBeenCalledTimes(1);
      expect(mockQb.where).toHaveBeenCalledWith(
        expect.stringContaining('ST_Collect'),
        expect.objectContaining({
          routeLng0_0: 10.4,
          routeLng1_1: 10.6,
        }),
      );
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

      expect(mockQb.where).toHaveBeenCalledWith(
        expect.stringContaining('ST_Expand'),
        expect.any(Object),
      );
      const calls = mockQb.where.mock.calls as [
        string,
        Record<string, unknown>,
      ][];
      const bufferLngDeg = calls[0]?.[1].bufferLngDeg;
      expect(typeof bufferLngDeg).toBe('number');
      expect(bufferLngDeg as number).toBeGreaterThan(0.0025);
    });

    it('defaults the buffer to 1500 m', async () => {
      mockRouteResult([]);
      await service.checkRoute({
        route: [
          { lat: 46.5, lng: 10.4 },
          { lat: 46.6, lng: 10.5 },
        ],
      });
      expect(mockQb.where).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ buffer: 1500 }),
      );
    });

    it('evaluates status for the supplied for_month', async () => {
      mockRouteResult([STELVIO], { closed: 1, unknown: 0 });
      // Today = August (open) but the caller is planning a March trip —
      // Stelvio must come back closed for the response.
      jest.spyOn(global.Date.prototype, 'getUTCMonth').mockReturnValue(7);
      const result = await service.checkRoute({
        route: [
          { lat: 46.5, lng: 10.4 },
          { lat: 46.6, lng: 10.5 },
        ],
        for_month: 3,
      });
      expect(result.passes[0].status).toBe('closed');
      expect(result.closed_count).toBe(1);
    });

    it('reports status totals from before the pass list cap', async () => {
      mockRouteResult([STELVIO, FORCED_CLOSED], {
        closed: 237,
        unknown: 14,
      });

      const result = await service.checkRoute({
        route: [
          { lat: 46.5, lng: 10.4 },
          { lat: 46.6, lng: 10.5 },
        ],
        for_month: 1,
      });

      expect(result.passes).toHaveLength(2);
      expect(result.closed_count).toBe(237);
      expect(result.unknown_count).toBe(14);
    });

    it('returns zero counts when no passes match the route', async () => {
      mockRouteResult([]);

      const result = await service.checkRoute({
        route: [
          { lat: 46.5, lng: 10.4 },
          { lat: 46.6, lng: 10.5 },
        ],
      });

      expect(result.passes).toEqual([]);
      expect(result.closed_count).toBe(0);
      expect(result.unknown_count).toBe(0);
    });
  });
});
