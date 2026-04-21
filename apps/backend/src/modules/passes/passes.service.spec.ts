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
    orderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([STELVIO]),
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
      mockQb.getMany.mockResolvedValueOnce([STELVIO, FORCED_CLOSED]);
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
        expect.stringContaining('ST_DWithin'),
        {
          buffer: 2000,
          lng0: 10.4,
          lat0: 46.5,
          lng1: 10.5,
          lat1: 46.6,
        },
      );
      expect(mockQb.orderBy).toHaveBeenCalledWith('p.elevation_m', 'DESC');
    });

    it('defaults the buffer to 1500 m', async () => {
      mockQb.getMany.mockResolvedValueOnce([]);
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
      mockQb.getMany.mockResolvedValueOnce([STELVIO]);
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
  });
});
