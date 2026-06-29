import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { User } from '../../entities/user.entity.js';
import { RoadClosure } from '../../entities/road-closure.entity.js';
import { Ride } from '../../entities/ride.entity.js';
import { FeatureFlag } from '../../entities/feature-flag.entity.js';
import type { AdminMetricsDto } from './dto/admin-metrics.dto.js';

@Injectable()
export class AdminMetricsService {
  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(RoadClosure)
    private readonly closures: Repository<RoadClosure>,
    @InjectRepository(Ride)
    private readonly rides: Repository<Ride>,
    @InjectRepository(FeatureFlag)
    private readonly flags: Repository<FeatureFlag>,
  ) {}

  async snapshot(): Promise<AdminMetricsDto> {
    const [users, closures, activeRides, featureFlags] = await Promise.all([
      this.users.count({ where: { deleted_at: IsNull() } }),
      this.closures.count(),
      this.rides.count({ where: { status: 'active' } }),
      this.flags.count(),
    ]);
    return {
      users,
      activeRides,
      featureFlags,
      closures,
    };
  }
}
