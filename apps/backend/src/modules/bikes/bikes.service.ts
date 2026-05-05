import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Bike } from '../../entities/bike.entity.js';
import { CreateBikeDto, UpdateBikeDto, BikeDto } from './dto/bike.dto.js';

const PG_UNIQUE_VIOLATION = '23505';

@Injectable()
export class BikesService {
  constructor(
    @InjectRepository(Bike)
    private readonly bikeRepo: Repository<Bike>,
  ) {}

  async list(userId: string): Promise<BikeDto[]> {
    const bikes = await this.bikeRepo.find({
      where: { user_id: userId },
      order: { created_at: 'DESC' },
    });
    return bikes.map((b) => this.toDto(b));
  }

  async create(userId: string, dto: CreateBikeDto): Promise<BikeDto> {
    const count = await this.bikeRepo.count({ where: { user_id: userId } });
    const isFirst = count === 0;
    const shouldActivate = isFirst || (dto.is_active ?? false);

    if (shouldActivate) {
      await this.deactivateAll(userId);
    }

    const bike = this.bikeRepo.create({
      user_id: userId,
      make: dto.make,
      model: dto.model,
      year: dto.year ?? null,
      is_active: shouldActivate,
      photo_url: dto.photo_url ?? null,
    });

    try {
      const saved = await this.bikeRepo.save(bike);
      return this.toDto(saved);
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        // A concurrent request activated a bike between our deactivation
        // and insert. Retry without activation.
        bike.is_active = false;
        const saved = await this.bikeRepo.save(bike);
        return this.toDto(saved);
      }
      throw err;
    }
  }

  async update(
    userId: string,
    bikeId: string,
    dto: UpdateBikeDto,
  ): Promise<BikeDto> {
    const bike = await this.bikeRepo.findOne({
      where: { id: bikeId, user_id: userId },
    });
    if (!bike) throw new NotFoundException('Bike not found');

    // If activating, deactivate others.
    if (dto.is_active) {
      await this.deactivateAllExcept(userId, bikeId);
    }

    if (dto.make !== undefined) bike.make = dto.make;
    if (dto.model !== undefined) bike.model = dto.model;
    if (dto.year !== undefined) bike.year = dto.year;
    if (dto.is_active !== undefined) bike.is_active = dto.is_active;
    if (dto.photo_url !== undefined) bike.photo_url = dto.photo_url;

    try {
      const saved = await this.bikeRepo.save(bike);
      return this.toDto(saved);
    } catch (err: unknown) {
      if (isUniqueViolation(err) && dto.is_active) {
        // A concurrent request activated a different bike. Deactivate
        // the conflicting one and retry.
        await this.deactivateAllExcept(userId, bikeId);
        const saved = await this.bikeRepo.save(bike);
        return this.toDto(saved);
      }
      throw err;
    }
  }

  async delete(userId: string, bikeId: string): Promise<void> {
    const result = await this.bikeRepo.delete({
      id: bikeId,
      user_id: userId,
    });
    if (result.affected === 0) throw new NotFoundException('Bike not found');
  }

  // ── helpers ──

  private async deactivateAll(userId: string): Promise<void> {
    const active = await this.bikeRepo.find({
      where: { user_id: userId, is_active: true },
    });
    for (const b of active) {
      b.is_active = false;
      await this.bikeRepo.save(b);
    }
  }

  private async deactivateAllExcept(
    userId: string,
    exceptId: string,
  ): Promise<void> {
    const active = await this.bikeRepo.find({
      where: { user_id: userId, is_active: true },
    });
    for (const b of active) {
      if (b.id !== exceptId) {
        b.is_active = false;
        await this.bikeRepo.save(b);
      }
    }
  }

  private toDto(b: Bike): BikeDto {
    return {
      id: b.id,
      make: b.make,
      model: b.model,
      year: b.year ?? null,
      isActive: b.is_active,
      photoUrl: b.photo_url ?? null,
      totalKm: 0,
      totalRides: 0,
      createdAt: b.created_at.toISOString(),
      updatedAt: b.updated_at.toISOString(),
    };
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    (err as Record<string, string>).code === PG_UNIQUE_VIOLATION
  );
}
