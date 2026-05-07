import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { Bike } from '../../entities/bike.entity.js';
import { Ride } from '../../entities/ride.entity.js';
import { CreateBikeDto, UpdateBikeDto, BikeDto } from './dto/bike.dto.js';

interface BikeStats {
  total_km: number;
  total_rides: number;
}

@Injectable()
export class BikesService {
  constructor(
    @InjectRepository(Bike)
    private readonly bikeRepo: Repository<Bike>,
    private readonly dataSource: DataSource,
  ) {}

  async list(userId: string): Promise<BikeDto[]> {
    const bikes = await this.bikeRepo.find({
      where: { user_id: userId },
      order: { created_at: 'DESC' },
    });
    if (bikes.length === 0) return [];
    const stats = await this.statsByBikeId(bikes.map((b) => b.id));
    return bikes.map((b) => this.toDto(b, stats.get(b.id)));
  }

  /**
   * Find the bike currently flagged active for the rider, or null if
   * the rider hasn't added one yet. Used by the ride-start path so the
   * created ride is tagged with the rider's daily-driver bike.
   */
  async findActive(userId: string): Promise<Bike | null> {
    return this.bikeRepo.findOne({
      where: { user_id: userId, is_active: true },
    });
  }

  /**
   * The active-flag swap MUST run inside a single transaction. The
   * `(user_id) WHERE is_active` partial unique index lets PostgreSQL
   * reject any state where two of a rider's bikes are active. Splitting
   * the deactivate / activate into separate statements outside a tx
   * would leave a window where a concurrent request could 23505 on
   * insert; nesting them in `dataSource.transaction` collapses the
   * window so concurrent activations serialize cleanly.
   */
  async create(userId: string, dto: CreateBikeDto): Promise<BikeDto> {
    return this.dataSource.transaction(async (tx) => {
      const repo = tx.getRepository(Bike);
      const count = await repo.count({ where: { user_id: userId } });
      const isFirst = count === 0;
      // First bike is implicitly active so the rider always has a
      // current bike — otherwise the mobile HUD would have no bike to
      // tag rides with.
      const shouldActivate = isFirst || (dto.is_active ?? false);

      if (shouldActivate) {
        await this.deactivateAll(tx, userId);
      }

      const bike = repo.create({
        user_id: userId,
        make: dto.make,
        model: dto.model,
        year: dto.year ?? null,
        is_active: shouldActivate,
        photo_url: dto.photo_url ?? null,
        icon: dto.icon ?? null,
        notes: dto.notes ?? null,
      });
      const saved = await repo.save(bike);
      return this.toDto(saved, undefined);
    });
  }

  async update(
    userId: string,
    bikeId: string,
    dto: UpdateBikeDto,
  ): Promise<BikeDto> {
    return this.dataSource.transaction(async (tx) => {
      const repo = tx.getRepository(Bike);
      const bike = await repo.findOne({
        where: { id: bikeId, user_id: userId },
      });
      if (!bike) throw new NotFoundException('Bike not found');

      // Disallow self-deactivation when this is the rider's only bike,
      // so they always have an active bike to tag rides against.
      if (dto.is_active === false && bike.is_active) {
        const total = await repo.count({ where: { user_id: userId } });
        if (total === 1) {
          // Silently keep it active — the rider had one bike and
          // tried to deactivate it. Treat as a no-op for this field.
          dto = { ...dto };
          delete dto.is_active;
        }
      }

      if (dto.is_active === true && !bike.is_active) {
        await this.deactivateAll(tx, userId);
      }

      if (dto.make !== undefined) bike.make = dto.make;
      if (dto.model !== undefined) bike.model = dto.model;
      if (dto.year !== undefined) bike.year = dto.year;
      if (dto.is_active !== undefined) bike.is_active = dto.is_active;
      if (dto.photo_url !== undefined) bike.photo_url = dto.photo_url;
      if (dto.icon !== undefined) bike.icon = dto.icon;
      if (dto.notes !== undefined) bike.notes = dto.notes;

      const saved = await repo.save(bike);
      const stats = await this.statsByBikeId([saved.id], tx);
      return this.toDto(saved, stats.get(saved.id));
    });
  }

  async delete(userId: string, bikeId: string): Promise<void> {
    await this.dataSource.transaction(async (tx) => {
      const repo = tx.getRepository(Bike);
      const bike = await repo.findOne({
        where: { id: bikeId, user_id: userId },
      });
      if (!bike) throw new NotFoundException('Bike not found');

      const wasActive = bike.is_active;
      await repo.delete({ id: bikeId, user_id: userId });

      // If the rider deleted their active bike, promote the most-recent
      // remaining bike to active so the rider keeps a current bike.
      if (wasActive) {
        const next = await repo.findOne({
          where: { user_id: userId },
          order: { created_at: 'DESC' },
        });
        if (next) {
          next.is_active = true;
          await repo.save(next);
        }
      }
    });
  }

  // ── helpers ──

  private async deactivateAll(
    tx: EntityManager,
    userId: string,
  ): Promise<void> {
    await tx
      .createQueryBuilder()
      .update(Bike)
      .set({ is_active: false })
      .where('user_id = :userId AND is_active = true', { userId })
      .execute();
  }

  private async statsByBikeId(
    bikeIds: string[],
    tx?: EntityManager,
  ): Promise<Map<string, BikeStats>> {
    const stats = new Map<string, BikeStats>();
    if (bikeIds.length === 0) return stats;

    const manager = tx ?? this.dataSource.manager;
    const rows = await manager
      .createQueryBuilder(Ride, 'r')
      .select('r.bike_id', 'bike_id')
      .addSelect('COUNT(*)', 'total_rides')
      .addSelect('COALESCE(SUM(r.distance_km), 0)', 'total_km')
      .where('r.bike_id IN (:...bikeIds)', { bikeIds })
      .andWhere("r.status = 'completed'")
      .groupBy('r.bike_id')
      .getRawMany<{
        bike_id: string;
        total_rides: string;
        total_km: string;
      }>();

    for (const row of rows) {
      stats.set(row.bike_id, {
        total_km: Number(row.total_km),
        total_rides: Number(row.total_rides),
      });
    }
    return stats;
  }

  private toDto(b: Bike, stats: BikeStats | undefined): BikeDto {
    return {
      id: b.id,
      make: b.make,
      model: b.model,
      year: b.year ?? null,
      isActive: b.is_active,
      photoUrl: b.photo_url ?? null,
      icon: b.icon ?? null,
      notes: b.notes ?? null,
      totalKm: stats?.total_km ?? 0,
      totalRides: stats?.total_rides ?? 0,
      createdAt: b.created_at.toISOString(),
      updatedAt: b.updated_at.toISOString(),
    };
  }
}
