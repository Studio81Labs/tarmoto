import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TilesService } from './tiles.service.js';
import { RoadSegment } from '../../entities/road-segment.entity.js';

describe('TilesService', () => {
  let service: TilesService;
  let segmentRepo: Partial<jest.Mocked<Repository<RoadSegment>>>;

  beforeEach(async () => {
    segmentRepo = {
      query: jest.fn().mockResolvedValue([{ tile: Buffer.from('mvt-data') }]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TilesService,
        { provide: getRepositoryToken(RoadSegment), useValue: segmentRepo },
      ],
    }).compile();

    service = module.get<TilesService>(TilesService);
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
});
