import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, IsNull, Not, Repository } from 'typeorm';
import { User } from '../../entities/user.entity.js';
import { Ride } from '../../entities/ride.entity.js';
import { HazardReport } from '../../entities/hazard-report.entity.js';
import { RoadReview } from '../../entities/road-review.entity.js';
import { Trip } from '../../entities/trip.entity.js';
import { CommuteRoute } from '../../entities/commute-route.entity.js';
import {
  AdminUserDetailDto,
  AdminUserListResponseDto,
  AdminUserRowDto,
  ListAdminUsersQueryDto,
} from './dto/admin-users.dto.js';

@Injectable()
export class AdminUsersService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Ride) private readonly rides: Repository<Ride>,
    @InjectRepository(HazardReport)
    private readonly hazards: Repository<HazardReport>,
    @InjectRepository(RoadReview)
    private readonly reviews: Repository<RoadReview>,
    @InjectRepository(Trip) private readonly trips: Repository<Trip>,
    @InjectRepository(CommuteRoute)
    private readonly commutes: Repository<CommuteRoute>,
  ) {}

  async list(query: ListAdminUsersQueryDto): Promise<AdminUserListResponseDto> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const deleted = query.deleted ?? 'active';

    const where: Record<string, unknown> = {};
    if (deleted === 'active') where.deleted_at = IsNull();
    else if (deleted === 'deleted') where.deleted_at = Not(IsNull());

    const whereClauses = query.q
      ? [
          { ...where, email: ILike(`%${query.q}%`) },
          { ...where, display_name: ILike(`%${query.q}%`) },
        ]
      : where;

    const [rows, total] = await this.users.findAndCount({
      where: whereClauses,
      order: { created_at: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    return { rows: rows.map((u) => this.toRow(u)), total, page, pageSize };
  }

  async getById(id: string): Promise<AdminUserDetailDto> {
    const u = await this.users.findOne({ where: { id } });
    if (!u) throw new NotFoundException('User not found');

    const [rides, hazardReports, roadReviews, trips, commuteRoutes] =
      await Promise.all([
        this.rides.count({ where: { user_id: id } }),
        this.hazards.count({ where: { user_id: id } }),
        this.reviews.count({ where: { user_id: id } }),
        this.trips.count({ where: { owner_id: id } }),
        this.commutes.count({ where: { user_id: id } }),
      ]);

    return {
      ...this.toRow(u),
      home_region: u.home_region,
      email_verified_at: u.email_verified_at?.toISOString() ?? null,
      subscription_current_period_end:
        u.subscription_current_period_end?.toISOString() ?? null,
      subscription_cancel_at_period_end: u.subscription_cancel_at_period_end,
      deletion_scheduled_at: u.deletion_scheduled_at?.toISOString() ?? null,
      deletion_reason: u.deletion_reason,
      activity: { rides, hazardReports, roadReviews, trips, commuteRoutes },
    };
  }

  async softDelete(id: string): Promise<void> {
    const u = await this.users.findOne({ where: { id } });
    if (!u) throw new NotFoundException('User not found');
    await this.users.update(
      { id },
      { deleted_at: new Date(), deletion_reason: 'Soft-deleted by admin' },
    );
  }

  async restore(id: string): Promise<void> {
    const u = await this.users.findOne({ where: { id } });
    if (!u) throw new NotFoundException('User not found');
    await this.users.update(
      { id },
      { deleted_at: null, deletion_scheduled_at: null, deletion_reason: null },
    );
  }

  private toRow(u: User): AdminUserRowDto {
    return {
      id: u.id,
      email: u.email,
      display_name: u.display_name,
      subscription_tier: u.subscription_tier,
      subscription_status: u.subscription_status,
      created_at: u.created_at.toISOString(),
      deleted_at: u.deleted_at?.toISOString() ?? null,
    };
  }
}
