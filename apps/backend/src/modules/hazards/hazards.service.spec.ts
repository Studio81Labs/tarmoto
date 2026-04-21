/* eslint-disable @typescript-eslint/no-unsafe-return */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { HazardsService } from './hazards.service.js';
import { HazardReport } from '../../entities/hazard-report.entity.js';
import { EXPIRY_HOURS } from './dto/create-hazard.dto.js';
import { EventsGateway } from '../events/events.gateway.js';

describe('HazardsService', () => {
  let service: HazardsService;
  let repo: Partial<jest.Mocked<Repository<HazardReport>>>;
  let eventsGateway: { emitHazardAlert: jest.Mock };

  const mockHazard: Partial<HazardReport> = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    user_id: 'user-1',
    location: { type: 'Point', coordinates: [16.75, 49.1] },
    hazard_type: 'pothole',
    severity: 'medium',
    note: 'Big pothole',
    confirmations: 0,
    is_active: true,
    created_at: new Date('2026-04-13T10:00:00Z'),
    expires_at: new Date('2026-04-16T10:00:00Z'),
    confirmed_at: null,
  };

  // Most tests exercise the `create` path which reloads the hazard via
  // `findActiveHazard` after save; default getOne to a hydrated copy of
  // whatever `save` just returned so reporter / road_name round-trip.
  let lastSaved: Partial<HazardReport> | null = null;

  beforeEach(async () => {
    lastSaved = null;
    repo = {
      create: jest
        .fn()
        .mockImplementation((data) => ({ ...mockHazard, ...data })),
      save: jest.fn().mockImplementation((entity) => {
        lastSaved = entity;
        return Promise.resolve(entity);
      }),
      findOne: jest.fn(),
      query: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 0 }),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockImplementation(() =>
          Promise.resolve(
            lastSaved
              ? {
                  ...lastSaved,
                  user: { display_name: 'TestRider' },
                  road_segment: null,
                }
              : null,
          ),
        ),
      }),
    };

    eventsGateway = { emitHazardAlert: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HazardsService,
        { provide: getRepositoryToken(HazardReport), useValue: repo },
        { provide: EventsGateway, useValue: eventsGateway },
      ],
    }).compile();

    service = module.get<HazardsService>(HazardsService);
  });

  describe('create', () => {
    it('should create a hazard with correct expiry', async () => {
      const dto = { lat: 49.1, lng: 16.75, hazard_type: 'pothole' as const };
      const before = Date.now();

      const result = await service.create('user-1', dto);

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: 'user-1',
          hazard_type: 'pothole',
          severity: 'medium',
          location: { type: 'Point', coordinates: [16.75, 49.1] },
        }),
      );
      expect(repo.save).toHaveBeenCalled();
      expect(result.hazard_type).toBe('pothole');
      expect(result.lat).toBe(49.1);
      expect(result.lng).toBe(16.75);

      // Verify expiry is ~72h for pothole
      const expiryTime = new Date(result.expires_at).getTime();
      const expectedExpiry = before + EXPIRY_HOURS['pothole'] * 60 * 60 * 1000;
      expect(Math.abs(expiryTime - expectedExpiry)).toBeLessThan(5000);
    });

    it('should broadcast new hazard via WebSocket', async () => {
      const dto = { lat: 49.1, lng: 16.75, hazard_type: 'pothole' as const };
      await service.create('user-1', dto);

      expect(eventsGateway.emitHazardAlert).toHaveBeenCalledWith(
        49.1,
        16.75,
        expect.objectContaining({
          hazard_type: 'pothole',
          lat: 49.1,
          lng: 16.75,
        }),
      );
    });

    it('should include reporter and road_name in the broadcast payload', async () => {
      const dto = { lat: 49.1, lng: 16.75, hazard_type: 'pothole' as const };
      await service.create('user-1', dto);

      // Ensures `save` is reloaded with relations before emit — otherwise
      // every new hazard would broadcast reporter:null to other riders.
      expect(eventsGateway.emitHazardAlert).toHaveBeenCalledWith(
        49.1,
        16.75,
        expect.objectContaining({
          reporter: 'TestRider',
          road_name: null,
          confirmations: expect.any(Number),
          created_at: expect.any(String),
          expires_at: expect.any(String),
        }),
      );
    });

    it('should use custom severity and note', async () => {
      const dto = {
        lat: 49.1,
        lng: 16.75,
        hazard_type: 'gravel' as const,
        severity: 'high' as const,
        note: 'Loose gravel after rain',
      };

      await service.create('user-1', dto);

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          severity: 'high',
          note: 'Loose gravel after rain',
        }),
      );
    });

    it('should use default severity when not provided', async () => {
      const dto = { lat: 49.1, lng: 16.75, hazard_type: 'oil_spill' as const };

      await service.create('user-1', dto);

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ severity: 'medium' }),
      );
    });

    it('should set different expiry hours per hazard type', async () => {
      for (const [type, hours] of Object.entries(EXPIRY_HOURS)) {
        const dto = { lat: 49.1, lng: 16.75, hazard_type: type as never };
        const before = Date.now();

        const result = await service.create('user-1', dto);

        const expiryTime = new Date(result.expires_at).getTime();
        const expectedExpiry = before + hours * 60 * 60 * 1000;
        expect(Math.abs(expiryTime - expectedExpiry)).toBeLessThan(5000);
      }
    });
  });

  describe('findNearby', () => {
    it('should query with correct parameters', async () => {
      const query = { lat: 49.1, lng: 16.75 };
      await service.findNearby(query);

      expect(repo.query).toHaveBeenCalledWith(
        expect.stringContaining('ST_DWithin'),
        [16.75, 49.1, 10000],
      );
    });

    it('should use custom radius', async () => {
      const query = { lat: 49.1, lng: 16.75, radius: 5000 };
      await service.findNearby(query);

      expect(repo.query).toHaveBeenCalledWith(
        expect.stringContaining('ST_DWithin'),
        [16.75, 49.1, 5000],
      );
    });

    it('should filter by hazard types when provided', async () => {
      const query = { lat: 49.1, lng: 16.75, types: 'pothole,gravel' };
      await service.findNearby(query);

      expect(repo.query).toHaveBeenCalledWith(
        expect.stringContaining('hazard_type = ANY'),
        expect.arrayContaining([16.75, 49.1, 10000]),
      );
    });

    it('should return mapped response DTOs', async () => {
      repo.query!.mockResolvedValueOnce([
        {
          id: 'h1',
          hazard_type: 'pothole',
          severity: 'high',
          note: null,
          confirmations: 3,
          created_at: new Date('2026-04-13T10:00:00Z'),
          expires_at: new Date('2026-04-16T10:00:00Z'),
          lat: 49.1,
          lng: 16.75,
          reporter: 'TestRider',
          road_name: 'D35',
        },
      ]);

      const results = await service.findNearby({ lat: 49.1, lng: 16.75 });

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        id: 'h1',
        lat: 49.1,
        lng: 16.75,
        hazard_type: 'pothole',
        severity: 'high',
        note: null,
        confirmations: 3,
        reporter: 'TestRider',
        road_name: 'D35',
        created_at: '2026-04-13T10:00:00.000Z',
        expires_at: '2026-04-16T10:00:00.000Z',
      });
    });
  });

  describe('confirm', () => {
    const makeSelectQb = (result: unknown) => ({
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(result),
    });
    const makeUpdateQb = () => ({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    });

    it('should atomically increment confirmations and extend expiry', async () => {
      const hazardWithUser = {
        ...mockHazard,
        user_id: 'reporter-1',
        user: { display_name: 'Reporter' },
        road_segment: null,
      };
      // 1st call: findActiveHazard (ownership check)
      // 2nd call: atomic UPDATE
      // 3rd call: findActiveHazard (reload)
      const selectQb1 = makeSelectQb(hazardWithUser);
      const updateQb = makeUpdateQb();
      const selectQb2 = makeSelectQb({
        ...hazardWithUser,
        confirmations: 1,
      });
      repo
        .createQueryBuilder!.mockReturnValueOnce(selectQb1 as never)
        .mockReturnValueOnce(updateQb as never)
        .mockReturnValueOnce(selectQb2 as never);

      const result = await service.confirm(mockHazard.id!, 'other-user');

      expect(updateQb.update).toHaveBeenCalledWith(HazardReport);
      expect(result.confirmations).toBe(1);
    });

    it('should prevent self-confirmation', async () => {
      const selectQb = makeSelectQb({
        ...mockHazard,
        user_id: 'user-1',
      });
      repo.createQueryBuilder!.mockReturnValueOnce(selectQb as never);

      await expect(service.confirm(mockHazard.id!, 'user-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw NotFoundException for missing hazard', async () => {
      const selectQb = makeSelectQb(null);
      repo.createQueryBuilder!.mockReturnValueOnce(selectQb as never);

      await expect(service.confirm('nonexistent-id', 'user-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('dismiss', () => {
    it('should set is_active to false', async () => {
      const selectQb = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(mockHazard),
      };
      repo.createQueryBuilder!.mockReturnValueOnce(selectQb as never);

      await service.dismiss(mockHazard.id!);

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ is_active: false }),
      );
    });

    it('should throw NotFoundException for missing hazard', async () => {
      const selectQb = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      };
      repo.createQueryBuilder!.mockReturnValueOnce(selectQb as never);

      await expect(service.dismiss('nonexistent-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('findAlongRoute', () => {
    it('should query with route LineString and buffer', async () => {
      const dto = {
        route: [
          { lat: 49.1, lng: 16.75 },
          { lat: 49.2, lng: 16.85 },
        ],
        buffer_m: 300,
      };

      await service.findAlongRoute(dto);

      expect(repo.query).toHaveBeenCalledWith(
        expect.stringContaining('ST_MakeLine'),
        [300, 16.75, 49.1, 16.85, 49.2],
      );
    });

    it('should use default 200m buffer', async () => {
      const dto = {
        route: [
          { lat: 49.1, lng: 16.75 },
          { lat: 49.2, lng: 16.85 },
        ],
      };

      await service.findAlongRoute(dto);

      expect(repo.query).toHaveBeenCalledWith(
        expect.stringContaining('ST_MakeLine'),
        [200, 16.75, 49.1, 16.85, 49.2],
      );
    });

    it('should throw for route with fewer than 2 points', async () => {
      const dto = { route: [{ lat: 49.1, lng: 16.75 }] };

      await expect(service.findAlongRoute(dto)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('expireOld', () => {
    it('should deactivate expired hazards', async () => {
      const mockQb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 5 }),
      };
      repo.createQueryBuilder!.mockReturnValueOnce(mockQb as never);

      const count = await service.expireOld();

      expect(count).toBe(5);
      expect(mockQb.set).toHaveBeenCalledWith({ is_active: false });
      expect(mockQb.where).toHaveBeenCalledWith(
        'is_active = true AND expires_at < NOW()',
      );
    });
  });
});
