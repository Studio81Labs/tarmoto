import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { User } from '../../entities/user.entity.js';
import { Ride } from '../../entities/ride.entity.js';
import { HazardReport } from '../../entities/hazard-report.entity.js';
import { RoadReview } from '../../entities/road-review.entity.js';
import { Trip } from '../../entities/trip.entity.js';
import { CommuteRoute } from '../../entities/commute-route.entity.js';
import { NotificationPreferencesService } from '../push/notification-preferences.service.js';
import { AccountDeletionService } from '../account/account-deletion.service.js';
import type {
  NotificationPreferencesResponseDto,
  UpdateNotificationPreferencesDto,
} from '../push/dto/notification-preferences.dto.js';
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
    private readonly notificationPrefs: NotificationPreferencesService,
    private readonly accountDeletion: AccountDeletionService,
  ) {}

  async list(query: ListAdminUsersQueryDto): Promise<AdminUserListResponseDto> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const deleted = query.deleted ?? 'active';

    const qb = this.users
      .createQueryBuilder('u')
      .orderBy('u.created_at', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    if (deleted === 'active') {
      qb.andWhere('u.deleted_at IS NULL');
    } else if (deleted === 'deleted') {
      qb.andWhere('u.deleted_at IS NOT NULL');
    }

    if (query.q) {
      qb.andWhere('(u.email ILIKE :q OR u.display_name ILIKE :q)', {
        q: `%${query.q}%`,
      });
    }

    if (query.subscription) {
      qb.andWhere(
        '(u.subscription_tier = :sub OR u.subscription_status = :sub)',
        { sub: query.subscription },
      );
    }

    const [rows, total] = await qb.getManyAndCount();

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
      plan_source: u.plan_source,
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
    // Idempotent: if the user is already soft-deleted, preserve the original
    // deleted_at timestamp rather than overwriting it with a newer value.
    if (u.deleted_at) return;
    await this.users.update(
      { id, deleted_at: IsNull() },
      { deleted_at: new Date(), deletion_reason: 'Soft-deleted by admin' },
    );
  }

  async restore(id: string): Promise<void> {
    const u = await this.users.findOne({ where: { id } });
    if (!u) throw new NotFoundException('User not found');
    // Delegate to the reversal path rather than clearing the columns directly:
    // it re-enables the rider's Stripe renewal (clears cancel_at_period_end) and
    // resolves any open deletion_cancel_failed reconciliation, all under the
    // per-rider advisory lock so it can't race the retry worker. It also clears
    // deleted_at / deletion_scheduled_at / deletion_reason, and is a safe no-op
    // for an account that isn't currently soft-deleted.
    await this.accountDeletion.restoreAccount(id);
  }

  /**
   * A user's notification preferences (defaults merged in when no row exists),
   * for support to inspect/adjust from the admin user detail. Reuses the same
   * service the user-facing settings endpoint uses, so the read shape and the
   * lazy-row semantics stay identical.
   */
  async getNotificationPreferences(
    id: string,
  ): Promise<NotificationPreferencesResponseDto> {
    await this.assertUserExists(id);
    return this.notificationPrefs.get(id);
  }

  async updateNotificationPreferences(
    id: string,
    dto: UpdateNotificationPreferencesDto,
  ): Promise<NotificationPreferencesResponseDto> {
    await this.assertUserExists(id);
    return this.notificationPrefs.update(id, dto);
  }

  private async assertUserExists(id: string): Promise<void> {
    const u = await this.users.findOne({ where: { id } });
    if (!u) throw new NotFoundException('User not found');
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
