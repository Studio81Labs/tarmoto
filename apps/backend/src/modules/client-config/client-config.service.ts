import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { FeatureFlagMap } from '@tarmoto/shared';
import { FeatureFlag } from '../../entities/feature-flag.entity.js';

@Injectable()
export class ClientConfigService {
  constructor(
    @InjectRepository(FeatureFlag)
    private readonly flagsRepo: Repository<FeatureFlag>,
  ) {}

  async flags(): Promise<FeatureFlagMap> {
    const rows = await this.flagsRepo.find({
      select: { key: true, enabled: true },
    });
    return rows.reduce<FeatureFlagMap>((acc, r) => {
      acc[r.key] = r.enabled;
      return acc;
    }, {});
  }
}
