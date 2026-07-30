/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import {
  access,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { Repository } from 'typeorm';
import { HazardsService, HAZARD_SELECT_BASE } from './hazards.service.js';
import { HazardReport } from '../../entities/hazard-report.entity.js';
import { CommuteRoute } from '../../entities/commute-route.entity.js';
import { EXPIRY_HOURS } from './dto/create-hazard.dto.js';
import { EventsGateway } from '../events/events.gateway.js';
import { PushService } from '../push/index.js';
import { PrivacyPreferencesService } from '../account/privacy-preferences.service.js';
import { FeatureResolver } from '../features/feature-resolver.service.js';
import { FEATURE_LIMIT_EXCEEDED } from '@tarmoto/shared';
import { DEFAULT_PRIVACY_PREFERENCES } from '@tarmoto/shared';

describe('HazardsService', () => {
  let service: HazardsService;
  let repo: Partial<jest.Mocked<Repository<HazardReport>>>;
  let eventsGateway: { emitHazardAlert: jest.Mock };
  let privacy: { loadPreferences: jest.Mock };
  let featureResolver: { resolveLimitsForUser: jest.Mock };

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
      // Default: well under the daily-report cap so existing create tests pass.
      count: jest.fn().mockResolvedValue(0),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
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

    privacy = {
      // Default — non-private profile so existing assertions about the
      // reporter showing through keep passing. Per-test overrides set
      // `profile_visibility: 'private'` to exercise the mask.
      loadPreferences: jest.fn().mockResolvedValue({
        ...DEFAULT_PRIVACY_PREFERENCES,
      }),
    };

    // Default: all tiers get 50/day; overridden per-test to exercise the cap.
    featureResolver = {
      resolveLimitsForUser: jest
        .fn()
        .mockResolvedValue({ hazard_reports_per_day: 50 }),
    };

    const commuteRepo = {
      query: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HazardsService,
        { provide: getRepositoryToken(HazardReport), useValue: repo },
        { provide: getRepositoryToken(CommuteRoute), useValue: commuteRepo },
        { provide: EventsGateway, useValue: eventsGateway },
        {
          provide: PushService,
          useValue: {
            sendToUser: jest.fn().mockResolvedValue(undefined),
            sendToUsers: jest
              .fn()
              .mockResolvedValue({ delivered: 0, pruned: 0, users: 0 }),
          },
        },
        { provide: PrivacyPreferencesService, useValue: privacy },
        {
          provide: FeatureResolver,
          useValue: featureResolver,
        },
        {
          provide: ConfigService,
          useValue: {
            // Default tests use loopback dev mode (no public-base URL),
            // which `buildTrustedManagedOriginCheck` treats as trusted
            // for any loopback host outside production. Photo-specific
            // tests below override this with a configured URL.
            get: jest.fn().mockReturnValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get<HazardsService>(HazardsService);
  });

  describe('create — hazard_reports_per_day cap', () => {
    it('rejects with FEATURE_LIMIT_EXCEEDED at the daily cap', async () => {
      featureResolver.resolveLimitsForUser.mockResolvedValueOnce({
        hazard_reports_per_day: 50,
      });
      (repo.count as jest.Mock).mockResolvedValueOnce(50); // already at cap

      const dto = { lat: 49.1, lng: 16.75, hazard_type: 'pothole' as const };
      await expect(service.create('user-1', dto)).rejects.toMatchObject({
        response: {
          code: FEATURE_LIMIT_EXCEEDED,
          feature: 'hazard_reports_per_day',
        },
      });
      // No report was written once the cap is hit.
      expect(repo.save).not.toHaveBeenCalled();
      // Count scoped to the caller over a rolling 24h window.
      expect(repo.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ user_id: 'user-1' }),
        }),
      );
    });

    it('allows the report when under the cap', async () => {
      featureResolver.resolveLimitsForUser.mockResolvedValueOnce({
        hazard_reports_per_day: 50,
      });
      (repo.count as jest.Mock).mockResolvedValueOnce(49);

      await expect(
        service.create('user-1', {
          lat: 49.1,
          lng: 16.75,
          hazard_type: 'pothole' as const,
        }),
      ).resolves.toBeDefined();
      expect(repo.save).toHaveBeenCalled();
    });

    it('skips the count entirely when the limit is null (unlimited)', async () => {
      featureResolver.resolveLimitsForUser.mockResolvedValueOnce({
        hazard_reports_per_day: null,
      });

      await service.create('user-1', {
        lat: 49.1,
        lng: 16.75,
        hazard_type: 'pothole' as const,
      });
      expect(repo.count).not.toHaveBeenCalled();
      expect(repo.save).toHaveBeenCalled();
    });

    it("deletes the caller's orphaned managed photo when the cap rejects", async () => {
      // Codex P2: the photo is uploaded by a prior POST /hazards/photos, so a
      // cap rejection here would strand the file (no orphan sweeper exists).
      // The owned upload must be cleaned up before the 403 is thrown.
      const tmpDir = join(process.cwd(), 'uploads', 'hazard-photos');
      await mkdir(tmpDir, { recursive: true });
      const filename = 'user-1-1700000000000-cap-orphan.jpg';
      const filePath = join(tmpDir, filename);
      await writeFile(filePath, 'orphan-bytes');

      featureResolver.resolveLimitsForUser.mockResolvedValueOnce({
        hazard_reports_per_day: 50,
      });
      (repo.count as jest.Mock).mockResolvedValueOnce(50); // at cap

      await expect(
        service.create('user-1', {
          lat: 49.1,
          lng: 16.75,
          hazard_type: 'pothole' as const,
          photo_url: `http://localhost:3000/uploads/hazard-photos/${filename}`,
        }),
      ).rejects.toMatchObject({
        response: { code: FEATURE_LIMIT_EXCEEDED },
      });

      expect(repo.save).not.toHaveBeenCalled();
      // The orphaned upload was purged rather than left to accumulate.
      await expect(access(filePath)).rejects.toThrow();
    });

    it('does NOT delete a photo still referenced by an accepted hazard', async () => {
      // Codex P2: uploads are not single-use. If a capped caller resubmits a
      // managed URL that some accepted hazard row already references, deleting
      // it would break that published hazard's image. Skip cleanup when a row
      // still references the file.
      const tmpDir = join(process.cwd(), 'uploads', 'hazard-photos');
      await mkdir(tmpDir, { recursive: true });
      const filename = 'user-1-1700000000000-still-referenced.jpg';
      const filePath = join(tmpDir, filename);
      await writeFile(filePath, 'in-use');

      featureResolver.resolveLimitsForUser.mockResolvedValueOnce({
        hazard_reports_per_day: 50,
      });
      // 1st count = daily cap (at cap); 2nd count = photo reference lookup (a
      // row still points at this URL).
      (repo.count as jest.Mock)
        .mockResolvedValueOnce(50)
        .mockResolvedValueOnce(1);

      await expect(
        service.create('user-1', {
          lat: 49.1,
          lng: 16.75,
          hazard_type: 'pothole' as const,
          photo_url: `http://localhost:3000/uploads/hazard-photos/${filename}`,
        }),
      ).rejects.toMatchObject({ response: { code: FEATURE_LIMIT_EXCEEDED } });

      // Referenced file survives.
      await expect(access(filePath)).resolves.toBeUndefined();
      await rm(filePath, { force: true });
    });

    it('checks photo references by resolved filename, not the raw URL string', async () => {
      // Codex P2: an equivalent URL serialization (query string, explicit port,
      // percent-encoding) resolves to the same file. The reference lookup must
      // match by filename so a resubmit with e.g. a query string can't slip past
      // an exact-string check and unlink a still-referenced photo.
      featureResolver.resolveLimitsForUser.mockResolvedValueOnce({
        hazard_reports_per_day: 50,
      });
      (repo.count as jest.Mock)
        .mockResolvedValueOnce(50) // daily cap → at cap
        .mockResolvedValueOnce(1); // reference lookup → still referenced

      const filename = 'user-1-1700000000000-canonical.jpg';
      await expect(
        service.create('user-1', {
          lat: 49.1,
          lng: 16.75,
          hazard_type: 'pothole' as const,
          // Equivalent serialization: an extra query string on the same file.
          photo_url: `http://localhost:3000/uploads/hazard-photos/${filename}?v=2`,
        }),
      ).rejects.toMatchObject({ response: { code: FEATURE_LIMIT_EXCEEDED } });

      // The reference lookup used a filename suffix LIKE, not the raw URL.
      const countCalls = (repo.count as jest.Mock).mock.calls as Array<
        [{ where: { photo_url: { value: string } } }]
      >;
      expect(countCalls[1]?.[0].where.photo_url.value).toBe(`%${filename}`);
    });

    it('does NOT delete the photo when the cap lookup fails transiently', async () => {
      // Codex P2: cleanup must be scoped to the actual FEATURE_LIMIT_EXCEEDED
      // rejection. A transient DB error in the limit lookup must re-throw
      // without unlinking a photo the retry (or another client) still uses.
      const tmpDir = join(process.cwd(), 'uploads', 'hazard-photos');
      await mkdir(tmpDir, { recursive: true });
      const filename = 'user-1-1700000000000-transient-keep.jpg';
      const filePath = join(tmpDir, filename);
      await writeFile(filePath, 'keep-me');

      featureResolver.resolveLimitsForUser.mockRejectedValueOnce(
        new Error('db connection reset'),
      );

      await expect(
        service.create('user-1', {
          lat: 49.1,
          lng: 16.75,
          hazard_type: 'pothole' as const,
          photo_url: `http://localhost:3000/uploads/hazard-photos/${filename}`,
        }),
      ).rejects.toThrow('db connection reset');

      expect(repo.save).not.toHaveBeenCalled();
      // File intact — a transient fault is not a cap rejection.
      await expect(access(filePath)).resolves.toBeUndefined();
      await rm(filePath, { force: true });
    });

    it("leaves another user's managed photo untouched and rejects before the cap check", async () => {
      // A non-owned photo attach is a 400 regardless of the cap, and the
      // cleanup must never unlink a file the caller doesn't own.
      const tmpDir = join(process.cwd(), 'uploads', 'hazard-photos');
      await mkdir(tmpDir, { recursive: true });
      const filename = 'other-user-1700000000000-foreign.jpg';
      const filePath = join(tmpDir, filename);
      await writeFile(filePath, 'not-mine');

      featureResolver.resolveLimitsForUser.mockResolvedValueOnce({
        hazard_reports_per_day: 50,
      });
      (repo.count as jest.Mock).mockResolvedValueOnce(50);

      await expect(
        service.create('user-1', {
          lat: 49.1,
          lng: 16.75,
          hazard_type: 'pothole' as const,
          photo_url: `http://localhost:3000/uploads/hazard-photos/${filename}`,
        }),
      ).rejects.toThrow(BadRequestException);

      // The ownership guard runs first, so the cap count is never reached and
      // the foreign file stays intact.
      expect(repo.count).not.toHaveBeenCalled();
      await expect(access(filePath)).resolves.toBeUndefined();
      await rm(filePath, { force: true });
    });
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

    it('should persist a managed photo_url when the caller owns the file', async () => {
      const dto = {
        lat: 49.1,
        lng: 16.75,
        hazard_type: 'pothole' as const,
        // The default ConfigService mock returns undefined for the
        // public-base URL, which makes loopback hosts trusted —
        // a `user-1-` filename matches the ownership prefix.
        photo_url:
          'http://localhost:3000/uploads/hazard-photos/user-1-1700000000000-abc.jpg',
      };

      const result = await service.create('user-1', dto);

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          photo_url:
            'http://localhost:3000/uploads/hazard-photos/user-1-1700000000000-abc.jpg',
        }),
      );
      expect(result.photo_url).toBe(
        'http://localhost:3000/uploads/hazard-photos/user-1-1700000000000-abc.jpg',
      );
    });

    it('should reject a managed photo_url uploaded by a different user', async () => {
      const dto = {
        lat: 49.1,
        lng: 16.75,
        hazard_type: 'pothole' as const,
        photo_url:
          'http://localhost:3000/uploads/hazard-photos/other-user-1700000000000-abc.jpg',
      };

      await expect(service.create('user-1', dto)).rejects.toThrow(
        BadRequestException,
      );
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('should accept third-party photo URLs without ownership checks', async () => {
      const dto = {
        lat: 49.1,
        lng: 16.75,
        hazard_type: 'pothole' as const,
        // Origin doesn't match `TARMOTO_PUBLIC_BASE_URL` and isn't
        // loopback, so the resolver classifies as third-party — we
        // never wrote it, we won't validate ownership for it, and it
        // round-trips through the response.
        photo_url: 'https://cdn.thirdparty.example.com/some-photo.jpg',
      };

      const result = await service.create('user-1', dto);

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          photo_url: 'https://cdn.thirdparty.example.com/some-photo.jpg',
        }),
      );
      expect(result.photo_url).toBe(
        'https://cdn.thirdparty.example.com/some-photo.jpg',
      );
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
          photo_url: null,
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
        photo_url: null,
        confirmations: 3,
        reporter: 'TestRider',
        road_name: 'D35',
        created_at: '2026-04-13T10:00:00.000Z',
        expires_at: '2026-04-16T10:00:00.000Z',
      });
    });

    it('should surface a managed photo_url in mapped responses and reject foreign URLs', async () => {
      repo.query!.mockResolvedValueOnce([
        {
          id: 'h1',
          hazard_type: 'pothole',
          severity: 'medium',
          note: null,
          // Loopback URL is trusted in dev — sanitizer keeps it.
          photo_url:
            'http://localhost:3000/uploads/hazard-photos/user-1-1700000000000-abc.jpg',
          confirmations: 0,
          created_at: new Date('2026-04-13T10:00:00Z'),
          expires_at: new Date('2026-04-14T10:00:00Z'),
          lat: 49.1,
          lng: 16.75,
          reporter: null,
          road_name: null,
        },
        {
          id: 'h2',
          hazard_type: 'gravel',
          severity: 'low',
          note: null,
          // Garbage value persisted directly to the DB at some point —
          // sanitizer must filter it out so the map doesn't try to
          // render an `<img src="not-a-url">`.
          photo_url: 'not-a-url',
          confirmations: 0,
          created_at: new Date('2026-04-13T10:00:00Z'),
          expires_at: new Date('2026-04-14T10:00:00Z'),
          lat: 49.2,
          lng: 16.85,
          reporter: null,
          road_name: null,
        },
      ]);

      const results = await service.findNearby({ lat: 49.1, lng: 16.75 });

      expect(results).toHaveLength(2);
      expect(results[0].photo_url).toBe(
        'http://localhost:3000/uploads/hazard-photos/user-1-1700000000000-abc.jpg',
      );
      expect(results[1].photo_url).toBeNull();
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

  describe('privacy: profile_visibility (#279 / #501)', () => {
    it('masks the reporter on broadcast when the rider profile is private', async () => {
      privacy.loadPreferences.mockResolvedValueOnce({
        ...DEFAULT_PRIVACY_PREFERENCES,
        profile_visibility: 'private',
      });

      const dto = { lat: 49.1, lng: 16.75, hazard_type: 'pothole' as const };
      const result = await service.create('user-1', dto);

      expect(result.reporter).toBeNull();
      // The WebSocket broadcast must also receive the masked DTO so
      // other clients can't see the rider's name even before the
      // next REST refresh.
      expect(eventsGateway.emitHazardAlert).toHaveBeenCalledWith(
        49.1,
        16.75,
        expect.objectContaining({ reporter: null }),
      );
    });

    it('keeps the reporter visible for a `riders-only` profile', async () => {
      privacy.loadPreferences.mockResolvedValueOnce({
        ...DEFAULT_PRIVACY_PREFERENCES,
        profile_visibility: 'riders-only',
      });

      const dto = { lat: 49.1, lng: 16.75, hazard_type: 'pothole' as const };
      const result = await service.create('user-1', dto);

      expect(result.reporter).toBe('TestRider');
    });

    it('fails closed when the privacy lookup throws (mask the name)', async () => {
      privacy.loadPreferences.mockRejectedValueOnce(new Error('db down'));

      const dto = { lat: 49.1, lng: 16.75, hazard_type: 'pothole' as const };
      const result = await service.create('user-1', dto);

      // A transient privacy lookup failure must not surface the name —
      // we'd rather mask a non-private rider once than risk leaking a
      // private one's identity.
      expect(result.reporter).toBeNull();
    });

    it('suppresses photo_url for private reporters so the filename cannot leak the user id (#501 review)', async () => {
      // Codex review on PR #513 r3212896110: managed hazard photo
      // filenames embed `<userId>-<ts>-...`, so emitting the URL
      // for a private reporter would leak the rider's UUID even
      // after the SQL CASE blanks `reporter`. The toResponse
      // mapper must suppress `photo_url` whenever the reporter is
      // private.
      privacy.loadPreferences.mockResolvedValueOnce({
        ...DEFAULT_PRIVACY_PREFERENCES,
        profile_visibility: 'private',
      });

      const dto = {
        lat: 49.1,
        lng: 16.75,
        hazard_type: 'pothole' as const,
        photo_url:
          'http://localhost:3000/uploads/hazard-photos/user-1-1700000000000-abc.jpg',
      };
      const result = await service.create('user-1', dto);

      expect(result.reporter).toBeNull();
      expect(result.photo_url).toBeNull();
      // The broadcast payload must also drop the URL so other
      // clients can't see the masked rider's id even before the
      // next REST refresh.
      expect(eventsGateway.emitHazardAlert).toHaveBeenCalledWith(
        49.1,
        16.75,
        expect.objectContaining({ photo_url: null }),
      );
    });

    it('keeps photo_url visible for non-private reporters (#501 review)', async () => {
      privacy.loadPreferences.mockResolvedValueOnce({
        ...DEFAULT_PRIVACY_PREFERENCES,
        profile_visibility: 'riders-only',
      });

      const dto = {
        lat: 49.1,
        lng: 16.75,
        hazard_type: 'pothole' as const,
        photo_url:
          'http://localhost:3000/uploads/hazard-photos/user-1-1700000000000-abc.jpg',
      };
      const result = await service.create('user-1', dto);

      expect(result.photo_url).toBe(
        'http://localhost:3000/uploads/hazard-photos/user-1-1700000000000-abc.jpg',
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

  describe('uploadPhoto', () => {
    const tmpDir = join(process.cwd(), 'uploads', 'hazard-photos');

    afterEach(async () => {
      // Clean any files this suite wrote so a re-run doesn't trip
      // ownership checks against stale `user-1-...` filenames.
      try {
        const entries = await readdir(tmpDir);
        await Promise.all(
          entries
            .filter((name) => name.startsWith('user-1-'))
            .map((name) => rm(join(tmpDir, name), { force: true })),
        );
      } catch {
        // dir may not exist if no uploadPhoto test ran in this run.
      }
    });

    it('should write the file to disk and return a URL under the public base', async () => {
      await mkdir(tmpDir, { recursive: true });
      const file = {
        mimetype: 'image/jpeg',
        buffer: Buffer.from('fake-jpg-bytes'),
      } as Express.Multer.File;

      const result = await service.uploadPhoto(
        'user-1',
        file,
        'https://app.tarmoto.test',
      );

      expect(result.photo_url).toMatch(
        /^https:\/\/app\.tarmoto\.test\/uploads\/hazard-photos\/user-1-\d+-[0-9a-f-]+\.jpg$/,
      );
      const filename = result.photo_url.split('/').pop()!;
      const written = await readFile(join(tmpDir, filename));
      expect(written.toString()).toBe('fake-jpg-bytes');
    });

    it('should reject unsupported mime types without writing anything', async () => {
      const file = {
        mimetype: 'application/pdf',
        buffer: Buffer.from('not-an-image'),
      } as Express.Multer.File;

      await expect(
        service.uploadPhoto('user-1', file, 'https://app.tarmoto.test'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('hidden hazards are excluded from public reads', () => {
    it('HAZARD_SELECT_BASE filters on moderation_status', () => {
      expect(HAZARD_SELECT_BASE).toContain("hr.moderation_status = 'visible'");
    });

    it('findActiveHazard passes moderation_status = visible to the query builder (tested via dismiss)', async () => {
      // findActiveHazard is private; dismiss is the simplest public caller.
      // Assert that the .where() clause passed to the query builder contains
      // the moderation gate so removing it would break this test.
      const whereSpy = jest.fn().mockReturnThis();
      const selectQb = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: whereSpy,
        getOne: jest.fn().mockResolvedValue(mockHazard),
      };
      repo.createQueryBuilder!.mockReturnValueOnce(selectQb as never);

      await service.dismiss(mockHazard.id!);

      expect(whereSpy).toHaveBeenCalledWith(
        expect.stringContaining("moderation_status = 'visible'"),
        expect.any(Object),
      );
    });
  });

  describe('adminHardDelete', () => {
    it('returns true, deletes the row, purges the photo, and emits a dismissed signal', async () => {
      const tmpDir = join(process.cwd(), 'uploads', 'hazard-photos');
      await mkdir(tmpDir, { recursive: true });
      const filename = `${mockHazard.user_id}-1700000000000-admin-del.jpg`;
      const filePath = join(tmpDir, filename);
      await writeFile(filePath, 'admin-delete-bytes');

      const hazardWithRelations = {
        ...mockHazard,
        photo_url: `http://localhost:3000/uploads/hazard-photos/${filename}`,
        user: { display_name: 'TestRider' },
        road_segment: null,
      };
      repo.findOne!.mockResolvedValueOnce(hazardWithRelations as never);

      const result = await service.adminHardDelete(mockHazard.id!);

      expect(result).toBe(true);
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { id: mockHazard.id },
        relations: ['user', 'road_segment'],
      });
      expect(repo.delete).toHaveBeenCalledWith({ id: mockHazard.id });
      // Photo was purged after the delete
      await expect(access(filePath)).rejects.toThrow();
      // Broadcast emitted with severity:'dismissed'
      expect(eventsGateway.emitHazardAlert).toHaveBeenCalledWith(
        49.1,
        16.75,
        expect.objectContaining({ severity: 'dismissed', id: mockHazard.id }),
      );
    });

    it('returns false and makes no changes when the hazard is not found', async () => {
      repo.findOne!.mockResolvedValueOnce(null);

      const result = await service.adminHardDelete('nonexistent-id');

      expect(result).toBe(false);
      expect(repo.delete).not.toHaveBeenCalled();
      expect(eventsGateway.emitHazardAlert).not.toHaveBeenCalled();
    });

    it('does not purge the photo or emit a broadcast when hazardRepo.delete rejects', async () => {
      const tmpDir = join(process.cwd(), 'uploads', 'hazard-photos');
      await mkdir(tmpDir, { recursive: true });
      const filename = `${mockHazard.user_id}-1700000000000-no-purge.jpg`;
      const filePath = join(tmpDir, filename);
      await writeFile(filePath, 'should-stay');

      const hazardWithRelations = {
        ...mockHazard,
        photo_url: `http://localhost:3000/uploads/hazard-photos/${filename}`,
        user: { display_name: 'TestRider' },
        road_segment: null,
      };
      repo.findOne!.mockResolvedValueOnce(hazardWithRelations as never);
      repo.delete!.mockRejectedValueOnce(new Error('db constraint'));

      await expect(service.adminHardDelete(mockHazard.id!)).rejects.toThrow(
        'db constraint',
      );

      // File must still be intact — delete threw before cleanup was reached
      await expect(access(filePath)).resolves.toBeUndefined();
      expect(eventsGateway.emitHazardAlert).not.toHaveBeenCalled();
    });

    it('still emits the removal broadcast when photo cleanup fails after the row delete', async () => {
      const tmpDir = join(process.cwd(), 'uploads', 'hazard-photos');
      await mkdir(tmpDir, { recursive: true });
      const filename = `${mockHazard.user_id}-1700000000000-purge-fail.jpg`;
      // A directory at the managed path makes unlink throw EISDIR/EPERM
      // (a non-ENOENT error deleteOwnedHazardPhoto rethrows), simulating an
      // uploads-dir failure after the DB row is already gone.
      const dirAsFile = join(tmpDir, filename);
      await mkdir(dirAsFile, { recursive: true });

      const hazardWithRelations = {
        ...mockHazard,
        photo_url: `http://localhost:3000/uploads/hazard-photos/${filename}`,
        user: { display_name: 'TestRider' },
        road_segment: null,
      };
      repo.findOne!.mockResolvedValueOnce(hazardWithRelations as never);

      await expect(service.adminHardDelete(mockHazard.id!)).rejects.toThrow();

      // Row delete succeeded and the dismissal was broadcast BEFORE the
      // purge threw, so connected maps still prune the marker.
      expect(repo.delete).toHaveBeenCalledWith({ id: mockHazard.id });
      expect(eventsGateway.emitHazardAlert).toHaveBeenCalledWith(
        49.1,
        16.75,
        expect.objectContaining({ severity: 'dismissed', id: mockHazard.id }),
      );

      await rm(dirAsFile, { recursive: true, force: true });
    });
  });

  describe('broadcastRemoval', () => {
    it('loads the hazard by id and emits a dismissed signal', async () => {
      const hazardWithRelations = {
        ...mockHazard,
        user: { display_name: 'TestRider' },
        road_segment: null,
      };
      repo.findOne!.mockResolvedValueOnce(hazardWithRelations as never);

      await service.broadcastRemoval(mockHazard.id!);

      expect(repo.findOne).toHaveBeenCalledWith({
        where: { id: mockHazard.id },
        relations: ['user', 'road_segment'],
      });
      expect(eventsGateway.emitHazardAlert).toHaveBeenCalledWith(
        49.1,
        16.75,
        expect.objectContaining({ severity: 'dismissed', id: mockHazard.id }),
      );
      // The removal payload must be REDACTED — the dismissed event fans out
      // to unauthenticated cell subscribers, so it must not re-broadcast the
      // abusive note / reporter / photo we're moderating away.
      const payload = (
        eventsGateway.emitHazardAlert.mock.calls[0] as unknown[]
      )[2] as Record<string, unknown>;
      expect(payload.note).toBeNull();
      expect(payload.reporter).toBeNull();
      expect(payload.road_name).toBeNull();
      expect(payload).not.toHaveProperty('photo_url');
    });

    it('is a no-op (emit NOT called) when the hazard id is not found', async () => {
      repo.findOne!.mockResolvedValueOnce(null);

      await service.broadcastRemoval('nonexistent-id');

      expect(eventsGateway.emitHazardAlert).not.toHaveBeenCalled();
    });
  });

  describe('broadcastRestore', () => {
    const visibleActiveHazard = {
      ...mockHazard,
      is_active: true,
      moderation_status: 'visible',
      expires_at: new Date(Date.now() + 72 * 60 * 60 * 1000), // 72 h from now
      user: { display_name: 'TestRider' },
      road_segment: null,
    };

    it('emits a normal hazard event (not dismissed) for a visible, active, unexpired hazard', async () => {
      repo.findOne!.mockResolvedValueOnce(visibleActiveHazard as never);

      await service.broadcastRestore(mockHazard.id!);

      expect(repo.findOne).toHaveBeenCalledWith({
        where: { id: mockHazard.id },
        relations: ['user', 'road_segment'],
      });
      expect(eventsGateway.emitHazardAlert).toHaveBeenCalledWith(
        49.1,
        16.75,
        expect.objectContaining({
          id: mockHazard.id,
          severity: 'medium', // normal severity — NOT 'dismissed'
        }),
      );
      // Confirm the emitted payload does NOT carry 'dismissed'
      const call = eventsGateway.emitHazardAlert.mock.calls[0] as [
        number,
        number,
        { severity: string },
      ];
      expect(call[2].severity).not.toBe('dismissed');
    });

    it('is a no-op when the hazard id is not found', async () => {
      repo.findOne!.mockResolvedValueOnce(null);

      await service.broadcastRestore('nonexistent-id');

      expect(eventsGateway.emitHazardAlert).not.toHaveBeenCalled();
    });

    it('is a no-op when the hazard is hidden (moderation_status !== visible)', async () => {
      repo.findOne!.mockResolvedValueOnce({
        ...visibleActiveHazard,
        moderation_status: 'hidden',
      } as never);

      await service.broadcastRestore(mockHazard.id!);

      expect(eventsGateway.emitHazardAlert).not.toHaveBeenCalled();
    });

    it('is a no-op when the hazard is inactive (is_active = false)', async () => {
      repo.findOne!.mockResolvedValueOnce({
        ...visibleActiveHazard,
        is_active: false,
      } as never);

      await service.broadcastRestore(mockHazard.id!);

      expect(eventsGateway.emitHazardAlert).not.toHaveBeenCalled();
    });

    it('is a no-op when the hazard has expired', async () => {
      repo.findOne!.mockResolvedValueOnce({
        ...visibleActiveHazard,
        expires_at: new Date(Date.now() - 1000), // 1 second in the past
      } as never);

      await service.broadcastRestore(mockHazard.id!);

      expect(eventsGateway.emitHazardAlert).not.toHaveBeenCalled();
    });
  });

  describe('dismiss cleanup', () => {
    it('should unlink the managed photo file when dismissing a hazard that owns one', async () => {
      const tmpDir = join(process.cwd(), 'uploads', 'hazard-photos');
      await mkdir(tmpDir, { recursive: true });
      // Match the ownership prefix so the dismiss cascade actually
      // unlinks the file (foreign-user files are skipped).
      const filename = `${mockHazard.user_id}-1700000000000-cleanup.jpg`;
      const filePath = join(tmpDir, filename);
      await writeFile(filePath, 'cleanup-bytes');

      const hazardWithPhoto = {
        ...mockHazard,
        photo_url: `http://localhost:3000/uploads/hazard-photos/${filename}`,
      };
      const selectQb = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(hazardWithPhoto),
      };
      repo.createQueryBuilder!.mockReturnValueOnce(selectQb as never);

      await service.dismiss(mockHazard.id!);

      await expect(access(filePath)).rejects.toThrow();
    });
  });
});
