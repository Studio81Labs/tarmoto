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
import { HazardsService } from './hazards.service.js';
import { HazardReport } from '../../entities/hazard-report.entity.js';
import { CommuteRoute } from '../../entities/commute-route.entity.js';
import { EXPIRY_HOURS } from './dto/create-hazard.dto.js';
import { EventsGateway } from '../events/events.gateway.js';
import { PushService } from '../push/index.js';
import { PrivacyPreferencesService } from '../account/privacy-preferences.service.js';
import { DEFAULT_PRIVACY_PREFERENCES } from '@tarmoto/shared';

describe('HazardsService', () => {
  let service: HazardsService;
  let repo: Partial<jest.Mocked<Repository<HazardReport>>>;
  let eventsGateway: { emitHazardAlert: jest.Mock };
  let privacy: { loadPreferences: jest.Mock };

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

    privacy = {
      // Default — non-private profile so existing assertions about the
      // reporter showing through keep passing. Per-test overrides set
      // `profile_visibility: 'private'` to exercise the mask.
      loadPreferences: jest.fn().mockResolvedValue({
        ...DEFAULT_PRIVACY_PREFERENCES,
      }),
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
