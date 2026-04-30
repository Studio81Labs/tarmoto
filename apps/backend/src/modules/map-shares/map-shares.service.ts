import { randomBytes } from 'node:crypto';
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MapShare } from '../../entities/map-share.entity.js';
import {
  CreateMapShareDto,
  MapShareListResponseDto,
  MapSharePublicDto,
  MapShareResponseDto,
} from './dto/map-share.dto.js';

@Injectable()
export class MapSharesService {
  constructor(
    @InjectRepository(MapShare)
    private readonly mapShareRepo: Repository<MapShare>,
  ) {}

  async create(
    userId: string,
    dto: CreateMapShareDto,
  ): Promise<MapShareResponseDto> {
    const created = await this.mapShareRepo.save(
      this.mapShareRepo.create({
        owner_id: userId,
        share_token: randomBytes(16).toString('hex'),
        title: dto.title,
        snapshot: dto.snapshot,
      }),
    );
    return this.toOwnerResponse(created);
  }

  async getByToken(token: string): Promise<MapSharePublicDto> {
    const share = await this.mapShareRepo.findOne({
      where: { share_token: token },
      relations: ['owner'],
    });
    // Soft-deleted owners (US-62) — pretend the share doesn't exist so
    // share-link traffic during the grace window can't surface the
    // owner's identity. 404 mirrors the unknown-token response so a
    // visitor can't side-channel whether the owner deleted their account
    // or the link was always invalid.
    if (!share || share.owner?.deleted_at != null) {
      throw new NotFoundException('Map share not found');
    }

    // Atomic UPDATE ... view_count = view_count + 1 so concurrent viewers
    // can't race each other into a lost update on the counter. The loaded
    // row is stale by one after this, so we bump it in-memory for the
    // response rather than re-selecting.
    await this.mapShareRepo.increment({ id: share.id }, 'view_count', 1);
    share.view_count = (share.view_count ?? 0) + 1;

    return this.toPublicResponse(share);
  }

  async listMine(userId: string): Promise<MapShareListResponseDto> {
    const [rows, total] = await this.mapShareRepo.findAndCount({
      where: { owner_id: userId },
      order: { created_at: 'DESC' },
    });
    return {
      items: rows.map((row) => this.toOwnerResponse(row)),
      total,
    };
  }

  async revoke(userId: string, id: string): Promise<void> {
    const share = await this.mapShareRepo.findOne({ where: { id } });
    if (!share) {
      throw new NotFoundException('Map share not found');
    }
    if (share.owner_id !== userId) {
      // 403, not 404 — hiding the row's existence from non-owners isn't
      // worth the debugging friction when a client sends the wrong id.
      throw new ForbiddenException('Not the owner of this map share');
    }
    await this.mapShareRepo.remove(share);
  }

  private toOwnerResponse(share: MapShare): MapShareResponseDto {
    return {
      id: share.id,
      share_token: share.share_token,
      share_url: this.buildShareUrl(share.share_token),
      title: share.title,
      view_count: share.view_count ?? 0,
      created_at: share.created_at.toISOString(),
      updated_at: share.updated_at.toISOString(),
    };
  }

  private toPublicResponse(share: MapShare): MapSharePublicDto {
    return {
      share_token: share.share_token,
      title: share.title,
      owner_name: share.owner?.display_name ?? 'Unknown',
      snapshot: share.snapshot,
      view_count: share.view_count ?? 0,
      created_at: share.created_at.toISOString(),
      updated_at: share.updated_at.toISOString(),
    };
  }

  private buildShareUrl(token: string): string {
    return `/rides/road-map/shared/${token}`;
  }
}
