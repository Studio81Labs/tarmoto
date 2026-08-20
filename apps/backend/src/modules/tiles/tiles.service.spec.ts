import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { buildLimitSnapshot } from '@tarmoto/shared';
import { TilesService } from './tiles.service.js';
import { RoadSegment } from '../../entities/road-segment.entity.js';
import { FeatureResolver } from '../features/feature-resolver.service.js';

const ANON_CLAMP_ENV = 'TARMOTO_TILES_ANON_QUALITY_ZOOM_CLAMP_ENABLED';

describe('TilesService', () => {
  let service: TilesService;
  let segmentRepo: Partial<jest.Mocked<Repository<RoadSegment>>>;
  let featureResolver: jest.Mocked<
    Pick<FeatureResolver, 'resolveLimitsForUser' | 'getGlobalLimitOverrides'>
  >;

  beforeEach(async () => {
    // The anonymous clamp leg is env-gated OFF by default; every pre-existing
    // test below runs anonymous with the env unset, i.e. today's behavior.
    delete process.env[ANON_CLAMP_ENV];
    segmentRepo = {
      query: jest.fn().mockResolvedValue([{ tile: Buffer.from('mvt-data') }]),
    };
    featureResolver = {
      resolveLimitsForUser: jest.fn(),
      getGlobalLimitOverrides: jest.fn().mockResolvedValue({}),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TilesService,
        { provide: getRepositoryToken(RoadSegment), useValue: segmentRepo },
        { provide: FeatureResolver, useValue: featureResolver },
      ],
    }).compile();

    service = module.get<TilesService>(TilesService);
  });

  afterEach(() => {
    delete process.env[ANON_CLAMP_ENV];
  });

  describe('getTile', () => {
    it('should return MVT buffer for valid tile coordinates', async () => {
      const result = await service.getTile(10, 550, 335);

      expect(result).toBeInstanceOf(Buffer);
      expect(segmentRepo.query).toHaveBeenCalledWith(
        expect.stringContaining('ST_AsMVT'),
        expect.any(Array),
      );
    });

    it('should use parameterized queries (no bbox interpolation)', async () => {
      await service.getTile(10, 550, 335, 'quality');

      const sql = segmentRepo.query!.mock.calls[0]![0];
      const params = segmentRepo.query!.mock.calls[0]![1] as number[];

      // SQL should have $N placeholders, not raw numbers
      expect(sql).toContain('ST_MakeEnvelope($');
      expect(sql).not.toMatch(/ST_MakeEnvelope\(\d+\.\d+/);
      // Params should contain bbox values
      expect(params.length).toBe(4);
      expect(params.every((p) => typeof p === 'number')).toBe(true);
    });

    it('should pass 12 params for all 3 layers (4 bbox params each)', async () => {
      await service.getTile(10, 550, 335, 'all');

      const params = segmentRepo.query!.mock.calls[0]![1] as number[];
      expect(params.length).toBe(12);
    });

    it('should rewrite param indices correctly for 3 layers (no $1 inside $10)', async () => {
      await service.getTile(10, 550, 335, 'all');

      const sql = segmentRepo.query!.mock.calls[0]![0];
      // Third layer (hazards) should use $9-$12, not $90/$91/$92
      expect(sql).toContain('$9');
      expect(sql).toContain('$12');
      expect(sql).not.toContain('$90');
      expect(sql).not.toContain('$91');
      expect(sql).not.toContain('$92');
    });

    it('should include quality layer by default', async () => {
      await service.getTile(10, 550, 335);

      expect(segmentRepo.query).toHaveBeenCalledWith(
        expect.stringContaining("'quality'"),
        expect.any(Array),
      );
    });

    it('should include surface layer by default', async () => {
      await service.getTile(10, 550, 335);

      expect(segmentRepo.query).toHaveBeenCalledWith(
        expect.stringContaining("'surface'"),
        expect.any(Array),
      );
    });

    it('should include hazards layer by default', async () => {
      await service.getTile(10, 550, 335);

      expect(segmentRepo.query).toHaveBeenCalledWith(
        expect.stringContaining("'hazards'"),
        expect.any(Array),
      );
    });

    it('should return only quality layer when requested', async () => {
      await service.getTile(10, 550, 335, 'quality');

      const sql = segmentRepo.query!.mock.calls[0]![0];
      expect(sql).toContain("'quality'");
      expect(sql).not.toContain("'surface'");
      expect(sql).not.toContain("'hazards'");
    });

    it('should return only hazards layer when requested', async () => {
      await service.getTile(10, 550, 335, 'hazards');

      const sql = segmentRepo.query!.mock.calls[0]![0];
      expect(sql).toContain("'hazards'");
      expect(sql).not.toContain("'quality'");
      expect(sql).not.toContain("'surface'");
    });

    it('should return null for empty tile', async () => {
      segmentRepo.query!.mockResolvedValueOnce([{ tile: null }]);

      const result = await service.getTile(10, 550, 335);

      expect(result).toBeNull();
    });

    it('should return null for zero-length tile', async () => {
      segmentRepo.query!.mockResolvedValueOnce([{ tile: Buffer.alloc(0) }]);

      const result = await service.getTile(10, 550, 335);

      expect(result).toBeNull();
    });

    it('should filter quality layer by non-null quality_score', async () => {
      await service.getTile(10, 550, 335, 'quality');

      const sql = segmentRepo.query!.mock.calls[0]![0];
      expect(sql).toContain('quality_score IS NOT NULL');
    });

    it('should filter hazards by is_active and expires_at', async () => {
      await service.getTile(10, 550, 335, 'hazards');

      const sql = segmentRepo.query!.mock.calls[0]![0];
      expect(sql).toContain('is_active = true');
      expect(sql).toContain('expires_at > NOW()');
    });

    it('should exclude hidden hazards from the MVT layer (moderation_status filter)', async () => {
      await service.getTile(10, 550, 335, 'hazards');

      const sql = segmentRepo.query!.mock.calls[0]![0];
      expect(sql).toContain("moderation_status = 'visible'");
    });
  });

  describe('road_quality_max_zoom server clamp (#1108)', () => {
    // Registry: free = 12, pro/premium = null (unlimited). Snapshots come
    // from the REAL shared resolver so the tests pin actual tier semantics,
    // not a hand-rolled fixture.
    const freeLimits = buildLimitSnapshot('free', {}, {});
    const proLimits = buildLimitSnapshot('pro', {}, {});
    const premiumLimits = buildLimitSnapshot('premium', {}, {});

    describe('authenticated requests (always enforced)', () => {
      it('withholds the quality layer above a FREE rider cap (z13 > 12), keeping surface + hazards', async () => {
        featureResolver.resolveLimitsForUser.mockResolvedValue(freeLimits);

        await service.getTile(13, 4400, 2680, 'all', 'user-free');

        expect(featureResolver.resolveLimitsForUser).toHaveBeenCalledWith(
          'user-free',
        );
        const sql = segmentRepo.query!.mock.calls[0]![0];
        const params = segmentRepo.query!.mock.calls[0]![1] as number[];
        expect(sql).not.toContain("'quality'");
        expect(sql).toContain("'surface'");
        expect(sql).toContain("'hazards'");
        // Two layers × 4 bbox params — the quality layer really was dropped
        // from the build, not just renamed.
        expect(params.length).toBe(8);
      });

      it('serves the quality layer AT the free cap (z12 = boundary is allowed)', async () => {
        featureResolver.resolveLimitsForUser.mockResolvedValue(freeLimits);

        await service.getTile(12, 2200, 1340, 'all', 'user-free');

        const sql = segmentRepo.query!.mock.calls[0]![0];
        expect(sql).toContain("'quality'");
      });

      it('returns null (→204) for layers=quality above the cap without touching the DB', async () => {
        featureResolver.resolveLimitsForUser.mockResolvedValue(freeLimits);

        const result = await service.getTile(
          13,
          4400,
          2680,
          'quality',
          'user-free',
        );

        expect(result).toBeNull();
        expect(segmentRepo.query).not.toHaveBeenCalled();
      });

      it('pro resolves null = unlimited: deep-zoom quality serves (z18)', async () => {
        featureResolver.resolveLimitsForUser.mockResolvedValue(proLimits);

        await service.getTile(18, 140000, 85000, 'quality', 'user-pro');

        const sql = segmentRepo.query!.mock.calls[0]![0];
        expect(sql).toContain("'quality'");
      });

      it('premium resolves null = unlimited: deep-zoom quality serves (z18)', async () => {
        featureResolver.resolveLimitsForUser.mockResolvedValue(premiumLimits);

        await service.getTile(18, 140000, 85000, 'quality', 'user-premium');

        const sql = segmentRepo.query!.mock.calls[0]![0];
        expect(sql).toContain("'quality'");
      });

      it('honours a stricter per-user override via the resolved snapshot', async () => {
        featureResolver.resolveLimitsForUser.mockResolvedValue(
          buildLimitSnapshot('pro', { road_quality_max_zoom: 10 }, {}),
        );

        const result = await service.getTile(
          11,
          1100,
          670,
          'quality',
          'user-overridden',
        );

        expect(result).toBeNull();
      });

      it('never clamps the surface/hazard layers (they are not quality data)', async () => {
        featureResolver.resolveLimitsForUser.mockResolvedValue(freeLimits);

        await service.getTile(16, 35000, 21000, 'surface', 'user-free');

        const sql = segmentRepo.query!.mock.calls[0]![0];
        expect(sql).toContain("'surface'");
        // No quality layer requested → no entitlement read either.
        expect(featureResolver.resolveLimitsForUser).not.toHaveBeenCalled();
      });
    });

    describe('anonymous requests (env-gated: dark until tile fetches carry identity)', () => {
      it("does NOT clamp with the env unset — today's behavior, zero resolver reads", async () => {
        await service.getTile(18, 140000, 85000, 'quality', null);

        const sql = segmentRepo.query!.mock.calls[0]![0];
        expect(sql).toContain("'quality'");
        expect(featureResolver.getGlobalLimitOverrides).not.toHaveBeenCalled();
        expect(featureResolver.resolveLimitsForUser).not.toHaveBeenCalled();
      });

      it('clamps to the free-tier registry cap (12) when enabled', async () => {
        process.env[ANON_CLAMP_ENV] = 'true';

        const above = await service.getTile(13, 4400, 2680, 'quality', null);
        expect(above).toBeNull();

        await service.getTile(12, 2200, 1340, 'quality', null);
        const sql = segmentRepo.query!.mock.calls[0]![0];
        expect(sql).toContain("'quality'");
        // Anonymous resolution is the free tier + the same global override
        // map the public /config/limits serves — never a per-user read.
        expect(featureResolver.getGlobalLimitOverrides).toHaveBeenCalled();
        expect(featureResolver.resolveLimitsForUser).not.toHaveBeenCalled();
      });

      it('honours the global operator override — the 1818 launch seed (null = unlimited) disables the clamp', async () => {
        process.env[ANON_CLAMP_ENV] = 'true';
        featureResolver.getGlobalLimitOverrides.mockResolvedValue({
          road_quality_max_zoom: null,
        });

        await service.getTile(18, 140000, 85000, 'quality', null);

        const sql = segmentRepo.query!.mock.calls[0]![0];
        expect(sql).toContain("'quality'");
      });

      it('honours a finite global operator override below the registry default', async () => {
        process.env[ANON_CLAMP_ENV] = 'true';
        featureResolver.getGlobalLimitOverrides.mockResolvedValue({
          road_quality_max_zoom: 10,
        });

        const result = await service.getTile(11, 1100, 670, 'quality', null);

        expect(result).toBeNull();
      });

      it('strips quality but keeps surface + hazards for layers=all above the cap', async () => {
        process.env[ANON_CLAMP_ENV] = 'true';

        await service.getTile(14, 8800, 5360, 'all', null);

        const sql = segmentRepo.query!.mock.calls[0]![0];
        const params = segmentRepo.query!.mock.calls[0]![1] as number[];
        expect(sql).not.toContain("'quality'");
        expect(sql).toContain("'surface'");
        expect(sql).toContain("'hazards'");
        expect(params.length).toBe(8);
      });
    });
  });
});
