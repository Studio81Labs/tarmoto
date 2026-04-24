import { randomBytes } from 'node:crypto';
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TripShare } from '../../entities/trip-share.entity.js';
import {
  CreateTripShareDto,
  TripShareListItemDto,
  TripShareListResponseDto,
  TripSharePublicDto,
  TripShareResponseDto,
} from './dto/trip-share.dto.js';

@Injectable()
export class TripSharesService {
  constructor(
    @InjectRepository(TripShare)
    private readonly tripShareRepo: Repository<TripShare>,
  ) {}

  async create(
    userId: string,
    dto: CreateTripShareDto,
  ): Promise<TripShareResponseDto> {
    const created = await this.tripShareRepo.save(
      this.tripShareRepo.create({
        owner_id: userId,
        share_token: randomBytes(16).toString('hex'),
        title: dto.title,
        snapshot: dto.snapshot,
      }),
    );
    return this.toOwnerResponse(created);
  }

  async getByToken(token: string): Promise<TripSharePublicDto> {
    const share = await this.tripShareRepo.findOne({
      where: { share_token: token },
      relations: ['owner'],
    });
    if (!share) {
      throw new NotFoundException('Trip share not found');
    }

    // Atomic UPDATE ... view_count = view_count + 1 so concurrent viewers
    // can't race each other into a lost-update on the counter. The loaded
    // row is stale by one after this, so we bump it in-memory for the
    // response rather than re-selecting.
    await this.tripShareRepo.increment({ id: share.id }, 'view_count', 1);
    share.view_count = (share.view_count ?? 0) + 1;

    return this.toPublicResponse(share);
  }

  async listMine(userId: string): Promise<TripShareListResponseDto> {
    const [rows, total] = await this.tripShareRepo.findAndCount({
      where: { owner_id: userId },
      order: { created_at: 'DESC' },
    });
    return {
      items: rows.map((row) => this.toListItem(row)),
      total,
    };
  }

  async revoke(userId: string, id: string): Promise<void> {
    const share = await this.tripShareRepo.findOne({ where: { id } });
    if (!share) {
      throw new NotFoundException('Trip share not found');
    }
    if (share.owner_id !== userId) {
      // 403, not 404 — hiding the row's existence from non-owners isn't
      // worth the debugging friction when a client sends the wrong id.
      throw new ForbiddenException('Not the owner of this trip share');
    }
    await this.tripShareRepo.remove(share);
  }

  private toOwnerResponse(share: TripShare): TripShareResponseDto {
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

  private toListItem(share: TripShare): TripShareListItemDto {
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

  private toPublicResponse(share: TripShare): TripSharePublicDto {
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
    return `/trips/shared/${token}`;
  }
}
