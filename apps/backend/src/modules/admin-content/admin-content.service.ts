import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, type ObjectLiteral } from 'typeorm';
import { HazardReport } from '../../entities/hazard-report.entity.js';
import { RoadReview } from '../../entities/road-review.entity.js';
import { TripMessage } from '../../entities/trip-message.entity.js';
import { User } from '../../entities/user.entity.js';
import { HazardsService } from '../hazards/hazards.service.js';
import { ReviewsService } from '../reviews/reviews.service.js';
import {
  CONTENT_TYPES,
  ContentType,
  type ContentTypeConfig,
} from './content-types.js';
import {
  ContentItemDto,
  ContentListResponseDto,
  ContentStatus,
  ListContentQueryDto,
} from './dto/admin-content.dto.js';

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/** Escape LIKE/ILIKE wildcards so user input is matched literally. */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

@Injectable()
export class AdminContentService {
  private readonly repos: Record<ContentType, Repository<ObjectLiteral>>;

  constructor(
    @InjectRepository(HazardReport)
    hazards: Repository<HazardReport>,
    @InjectRepository(RoadReview)
    reviews: Repository<RoadReview>,
    @InjectRepository(TripMessage)
    messages: Repository<TripMessage>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly hazardsService: HazardsService,
    private readonly reviewsService: ReviewsService,
  ) {
    this.repos = {
      [ContentType.Hazard]: hazards,
      [ContentType.Review]: reviews,
      [ContentType.TripMessage]: messages,
    };
  }

  private configFor(type: ContentType): {
    config: ContentTypeConfig;
    repo: Repository<ObjectLiteral>;
  } {
    const config = CONTENT_TYPES[type];
    const repo = this.repos[type];
    if (!config || !repo) {
      throw new BadRequestException(`Unknown content type: ${String(type)}`);
    }
    return { config, repo };
  }

  async list(query: ListContentQueryDto): Promise<ContentListResponseDto> {
    const { config, repo } = this.configFor(query.type);
    const page = query.page && query.page > 0 ? query.page : 1;
    const pageSize = Math.min(
      query.pageSize && query.pageSize > 0 ? query.pageSize : DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE,
    );

    const qb = repo
      .createQueryBuilder('c')
      .orderBy('c.created_at', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    if (query.status && query.status !== 'all') {
      qb.andWhere('c.moderation_status = :status', { status: query.status });
    }
    const term = query.q?.trim();
    if (term) {
      qb.andWhere(`c.${config.textColumn} ILIKE :q`, {
        q: `%${escapeLike(term)}%`,
      });
    }

    const [rows, total] = await qb.getManyAndCount();
    const items = await this.project(query.type, config, rows);
    return { rows: items, total, page, pageSize };
  }

  async hide(
    type: ContentType,
    id: string,
    actingAdminId: string,
    reason: string | null,
  ): Promise<ContentItemDto> {
    const { repo } = this.configFor(type);
    const result = await repo.update(
      { id },
      {
        moderation_status: 'hidden',
        moderation_reason: reason ?? null,
        moderated_by: actingAdminId,
        moderated_at: new Date(),
      },
    );
    if (!result.affected) throw new NotFoundException('Content not found');
    if (type === ContentType.Hazard) {
      await this.hazardsService.broadcastRemoval(id);
    }
    return this.getOne(type, id);
  }

  async restore(type: ContentType, id: string): Promise<ContentItemDto> {
    const { repo } = this.configFor(type);
    const result = await repo.update(
      { id },
      {
        moderation_status: 'visible',
        moderation_reason: null,
        moderated_by: null,
        moderated_at: null,
      },
    );
    if (!result.affected) throw new NotFoundException('Content not found');
    return this.getOne(type, id);
  }

  async remove(type: ContentType, id: string): Promise<void> {
    const { repo } = this.configFor(type);
    // Purge managed photos BEFORE the row delete so the entity is still
    // loadable. The per-service helpers already guard path traversal and
    // swallow ENOENT / not-owned files, so a missing file won't 500.
    if (type === ContentType.Hazard) {
      // Broadcast removal before the row is gone so lat/lng are still
      // readable. purgeManagedPhoto is fine in either order — it only
      // reads the row to find the filename.
      await this.hazardsService.broadcastRemoval(id);
      await this.hazardsService.purgeManagedPhoto(id);
    } else if (type === ContentType.Review) {
      await this.reviewsService.purgeManagedPhotos(id);
    }
    const result = await repo.delete({ id });
    if (!result.affected) throw new NotFoundException('Content not found');
  }

  private async getOne(type: ContentType, id: string): Promise<ContentItemDto> {
    const { config, repo } = this.configFor(type);
    const row = await repo.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Content not found');
    const [item] = await this.project(type, config, [row]);
    return item;
  }

  private async project(
    type: ContentType,
    config: ContentTypeConfig,
    rows: ObjectLiteral[],
  ): Promise<ContentItemDto[]> {
    const authorIds = [
      ...new Set(
        rows
          .map((r) => r.user_id as string | null | undefined)
          .filter((v): v is string => !!v),
      ),
    ];
    const nameById = new Map<string, string>();
    if (authorIds.length > 0) {
      const authors = await this.users.find({
        where: { id: In(authorIds) },
        select: { id: true, display_name: true },
      });
      for (const a of authors) nameById.set(a.id, a.display_name);
    }

    return rows.map((row) => {
      const authorId = (row.user_id as string | null) ?? null;
      const createdAt = row.created_at as Date;
      const moderatedAt = row.moderated_at as Date | null;
      return {
        type,
        id: row.id as string,
        authorId,
        authorName: authorId ? (nameById.get(authorId) ?? null) : null,
        text: (row[config.textColumn] as string | null) ?? null,
        photoUrls: config.toPhotoUrls(row),
        createdAt: createdAt.toISOString(),
        status: row.moderation_status as ContentStatus,
        moderationReason: (row.moderation_reason as string | null) ?? null,
        moderatedAt: moderatedAt ? moderatedAt.toISOString() : null,
        location: config.toLocation(row),
      };
    });
  }
}
