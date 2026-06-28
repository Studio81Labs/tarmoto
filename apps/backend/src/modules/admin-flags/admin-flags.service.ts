import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FeatureFlag } from '../../entities/feature-flag.entity.js';
import {
  CreateFeatureFlagDto,
  FeatureFlagDto,
  UpdateFeatureFlagDto,
} from './dto/admin-flags.dto.js';

@Injectable()
export class AdminFlagsService {
  constructor(
    @InjectRepository(FeatureFlag)
    private readonly flags: Repository<FeatureFlag>,
  ) {}

  async list(): Promise<FeatureFlagDto[]> {
    const rows = await this.flags.find({ order: { key: 'ASC' } });
    return rows.map((r) => this.toDto(r));
  }

  async create(dto: CreateFeatureFlagDto): Promise<FeatureFlagDto> {
    const existing = await this.flags.findOne({ where: { key: dto.key } });
    if (existing) {
      throw new ConflictException('A flag with this key already exists');
    }
    const entity = this.flags.create({
      key: dto.key,
      enabled: dto.enabled ?? false,
      description: dto.description ?? null,
    });
    try {
      const saved = await this.flags.save(entity);
      return this.toDto(saved);
    } catch (err) {
      // Race backstop: the unique index caught a concurrent insert.
      if ((err as { code?: string })?.code === '23505') {
        throw new ConflictException('A flag with this key already exists');
      }
      throw err;
    }
  }

  async update(id: string, dto: UpdateFeatureFlagDto): Promise<FeatureFlagDto> {
    const existing = await this.flags.findOne({ where: { id } });
    if (!existing) throw new NotFoundException('Flag not found');

    const patch: Partial<FeatureFlag> = {};
    if (dto.enabled !== undefined) patch.enabled = dto.enabled;
    if (dto.description !== undefined) patch.description = dto.description;
    if (Object.keys(patch).length > 0) {
      await this.flags.update({ id }, patch);
    }
    return this.toDto({ ...existing, ...patch });
  }

  async remove(id: string): Promise<void> {
    const existing = await this.flags.findOne({ where: { id } });
    if (!existing) throw new NotFoundException('Flag not found');
    await this.flags.delete({ id });
  }

  private toDto(r: FeatureFlag): FeatureFlagDto {
    return {
      id: r.id,
      key: r.key,
      enabled: r.enabled,
      description: r.description,
      created_at: r.created_at.toISOString(),
      updated_at: r.updated_at.toISOString(),
    };
  }
}
