import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import type { PushNotificationInput } from './push.service.js';
import { UserNotification } from '../../entities/user-notification.entity.js';
import {
  InAppNotificationDto,
  InAppNotificationListResponseDto,
} from './dto/in-app-notification.dto.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

@Injectable()
export class InAppNotificationsService {
  constructor(
    @InjectRepository(UserNotification)
    private readonly repo: Repository<UserNotification>,
  ) {}

  async create(
    userId: string,
    input: PushNotificationInput,
  ): Promise<InAppNotificationDto> {
    const saved = await this.repo.save(
      this.repo.create({
        user_id: userId,
        category: input.category,
        title: input.title,
        body: input.body,
        data: input.data ?? {},
      }),
    );
    return toDto(saved);
  }

  async list(
    userId: string,
    limit = DEFAULT_LIMIT,
  ): Promise<InAppNotificationListResponseDto> {
    const safeLimit = Number.isFinite(limit) ? limit : DEFAULT_LIMIT;
    const bounded = Math.min(Math.max(safeLimit, 1), MAX_LIMIT);
    const [items, unreadCount] = await Promise.all([
      this.repo.find({
        where: { user_id: userId },
        order: { created_at: 'DESC' },
        take: bounded,
      }),
      this.repo.count({ where: { user_id: userId, read_at: IsNull() } }),
    ]);

    return {
      items: items.map(toDto),
      unread_count: unreadCount,
    };
  }

  async markRead(userId: string, id: string): Promise<InAppNotificationDto> {
    const row = await this.repo.findOne({ where: { id, user_id: userId } });
    if (!row) throw new NotFoundException('Notification not found');
    if (!row.read_at) {
      row.read_at = new Date();
      await this.repo.save(row);
    }
    return toDto(row);
  }

  async markAllRead(userId: string): Promise<InAppNotificationListResponseDto> {
    await this.repo
      .createQueryBuilder()
      .update(UserNotification)
      .set({ read_at: () => 'NOW()' })
      .where('user_id = :userId', { userId })
      .andWhere('read_at IS NULL')
      .execute();
    return this.list(userId);
  }
}

function toDto(row: UserNotification): InAppNotificationDto {
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    body: row.body,
    data: row.data ?? {},
    read_at: row.read_at ? row.read_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
  };
}
