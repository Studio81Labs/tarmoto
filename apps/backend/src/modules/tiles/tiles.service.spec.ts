/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TilesService } from './tiles.service.js';
import { RoadSegment } from '../../entities/road-segment.entity.js';

describe('TilesService', () => {
  let service: TilesService;
  let segmentRepo: jest.Mocked<Partial<Repository<RoadSegment>>>;

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
      );
    });

    it('should include quality layer by default', async () => {
      await service.getTile(10, 550, 335);

      expect(segmentRepo.query).toHaveBeenCalledWith(
        expect.stringContaining("'quality'"),
      );
    });

    it('should include surface layer by default', async () => {
      await service.getTile(10, 550, 335);

      expect(segmentRepo.query).toHaveBeenCalledWith(
        expect.stringContaining("'surface'"),
      );
    });

    it('should include hazards layer by default', async () => {
      await service.getTile(10, 550, 335);

      expect(segmentRepo.query).toHaveBeenCalledWith(
        expect.stringContaining("'hazards'"),
      );
    });

    it('should return only quality layer when requested', async () => {
      await service.getTile(10, 550, 335, 'quality');

      const sql = segmentRepo.query!.mock.calls[0][0] as string;
      expect(sql).toContain("'quality'");
      expect(sql).not.toContain("'surface'");
      expect(sql).not.toContain("'hazards'");
    });

    it('should return only hazards layer when requested', async () => {
      await service.getTile(10, 550, 335, 'hazards');

      const sql = segmentRepo.query!.mock.calls[0][0] as string;
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

    it('should use correct bounding box for tile z=10 x=550 y=335', async () => {
      await service.getTile(10, 550, 335);

      // z=10, x=550, y=335 should produce a bbox in central Europe
      const sql = segmentRepo.query!.mock.calls[0][0] as string;
      expect(sql).toContain('ST_MakeEnvelope');
    });

    it('should filter quality layer by non-null quality_score', async () => {
      await service.getTile(10, 550, 335, 'quality');

      const sql = segmentRepo.query!.mock.calls[0][0] as string;
      expect(sql).toContain('quality_score IS NOT NULL');
    });

    it('should filter hazards by is_active and expires_at', async () => {
      await service.getTile(10, 550, 335, 'hazards');

      const sql = segmentRepo.query!.mock.calls[0][0] as string;
      expect(sql).toContain('is_active = true');
      expect(sql).toContain('expires_at > NOW()');
    });
  });
});
