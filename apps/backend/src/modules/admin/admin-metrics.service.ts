import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { User } from '../../entities/user.entity.js';
import { RoadClosure } from '../../entities/road-closure.entity.js';
import type { AdminMetricsDto } from './dto/admin-metrics.dto.js';

@Injectable()
export class AdminMetricsService {
  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(RoadClosure)
    private readonly closures: Repository<RoadClosure>,
  ) {}

  async snapshot(): Promise<AdminMetricsDto> {
    const [users, pendingClosures] = await Promise.all([
      this.users.count({ where: { deleted_at: IsNull() } }),
      this.closures.count(),
    ]);
    return {
      users,
      activeRides: 0, // wired to the rides module in a later phase
      featureFlags: 0, // wired when the flag store lands (Phase 3)
      pendingClosures,
    };
  }
}
