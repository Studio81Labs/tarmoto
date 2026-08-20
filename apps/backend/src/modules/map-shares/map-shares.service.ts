import { randomBytes } from 'node:crypto';
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MapShare } from '../../entities/map-share.entity.js';
import { FeatureResolver } from '../features/feature-resolver.service.js';
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
    private readonly featureResolver: FeatureResolver,
  ) {}

  async create(
    userId: string,
    dto: CreateMapShareDto,
  ): Promise<MapShareResponseDto> {
    // Operator kill switch: the personal road map is gamification surface,
    // and a killed switch must stop NEW snapshots from being minted and
    // persisted mid-incident — not just hide existing ones. Writes reject
    // loudly (503, same shape as challenge joins under this switch) rather
    // than degrading silently like the read paths.
    if (
      !(await this.featureResolver.isSystemSwitchEnabled('sys_gamification'))
    ) {
      throw new ServiceUnavailableException(
        'Gamification is temporarily unavailable',
      );
    }

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
    // Operator kill switch: with sys_gamification off, published snapshots
    // must stop being served — including to anonymous share-link visitors.
    // The 404 matches the unknown-token response below (same exception,
    // same message) so a visitor cannot side-channel WHY a share is
    // unavailable — the same indistinguishability the soft-deleted-owner
    // branch preserves. Checked before the repo read so a disable takes
    // effect immediately and does no per-request work.
    if (
      !(await this.featureResolver.isSystemSwitchEnabled('sys_gamification'))
    ) {
      throw new NotFoundException('Map share not found');
    }

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

  // listMine and revoke deliberately carry NO sys_gamification check: an
  // owner must still be able to find and take down an existing share
  // mid-incident. A kill switch may stop new content and hide published
  // content, but never remove the rider's ability to withdraw what is
  // already theirs — same rule as the billing portal under
  // sys_billing_checkout and clearVote / review delete under
  // sys_poi_ratings.
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
