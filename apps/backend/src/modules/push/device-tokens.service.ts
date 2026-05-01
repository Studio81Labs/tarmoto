import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { DeviceToken } from '../../entities/device-token.entity.js';
import {
  RegisterDeviceDto,
  RegisterDeviceResponseDto,
} from './dto/register-device.dto.js';

/**
 * Manages the per-(user, token) registration of FCM/APN handles.
 *
 * Register is upsert: same user + same token = touch `updated_at`
 * + clear `deleted_at`. The same physical device rotating its token
 * shows up as a new row, with the previous one going stale until
 * the dispatch path soft-deletes it on next failure.
 *
 * Unregister is soft (`deleted_at`). On re-register the row is
 * undeleted so the next dispatch picks it up; this keeps the
 * id stable across sign-out / sign-in cycles.
 */
@Injectable()
export class DeviceTokensService {
  private readonly logger = new Logger(DeviceTokensService.name);

  constructor(
    @InjectRepository(DeviceToken)
    private readonly repo: Repository<DeviceToken>,
  ) {}

  async register(
    userId: string,
    dto: RegisterDeviceDto,
  ): Promise<RegisterDeviceResponseDto> {
    const existing = await this.repo.findOne({
      where: { user_id: userId, token: dto.token },
    });

    if (existing) {
      existing.platform = dto.platform;
      existing.app_version = dto.app_version ?? null;
      existing.deleted_at = null;
      const saved = await this.repo.save(existing);
      this.logger.log(
        `re-registered device user=${userId} platform=${saved.platform} id=${saved.id}`,
      );
      return toResponse(saved);
    }

    const row = this.repo.create({
      user_id: userId,
      platform: dto.platform,
      token: dto.token,
      app_version: dto.app_version ?? null,
    });
    const saved = await this.repo.save(row);
    this.logger.log(
      `registered device user=${userId} platform=${saved.platform} id=${saved.id}`,
    );
    return toResponse(saved);
  }

  async unregister(userId: string, token: string): Promise<void> {
    const result = await this.repo.update(
      { user_id: userId, token, deleted_at: IsNull() },
      { deleted_at: new Date() },
    );
    if (result.affected) {
      this.logger.log(`unregistered device user=${userId}`);
    }
  }

  async unregisterAllForUser(userId: string): Promise<number> {
    const result = await this.repo.update(
      { user_id: userId, deleted_at: IsNull() },
      { deleted_at: new Date() },
    );
    return result.affected ?? 0;
  }
}

function toResponse(row: DeviceToken): RegisterDeviceResponseDto {
  return {
    device_id: row.id,
    platform: row.platform,
    registered_at: row.created_at.toISOString(),
  };
}
