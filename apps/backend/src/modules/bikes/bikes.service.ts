import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Bike } from '../../entities/bike.entity.js';
import { CreateBikeDto, UpdateBikeDto, BikeDto } from './dto/bike.dto.js';

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
    return bikes.map((b) => this.toDto(b));
  }

  async create(userId: string, dto: CreateBikeDto): Promise<BikeDto> {
    return this.dataSource.transaction(async (em) => {
      const bikeRepo = em.getRepository(Bike);
      const count = await bikeRepo.count({ where: { user_id: userId } });
      const isFirst = count === 0;

      // First bike is always active; explicit active flag also deactivates others.
      const shouldActivate = isFirst || (dto.is_active ?? false);
      if (shouldActivate) {
        await bikeRepo.update({ user_id: userId }, { is_active: false });
      }

      const bike = bikeRepo.create({
        user_id: userId,
        make: dto.make,
        model: dto.model,
        year: dto.year ?? null,
        is_active: shouldActivate,
        photo_url: dto.photo_url ?? null,
      });
      const saved = await bikeRepo.save(bike);
      return this.toDto(saved);
    });
  }

  async update(
    userId: string,
    bikeId: string,
    dto: UpdateBikeDto,
  ): Promise<BikeDto> {
    return this.dataSource.transaction(async (em) => {
      const bikeRepo = em.getRepository(Bike);
      const bike = await bikeRepo.findOne({
        where: { id: bikeId, user_id: userId },
      });
      if (!bike) throw new NotFoundException('Bike not found');

      // If activating, deactivate others.
      if (dto.is_active) {
        await bikeRepo.update({ user_id: userId }, { is_active: false });
      }

      // Only set explicitly provided fields — don't clear fields the
      // caller didn't include in the payload.
      if (dto.make !== undefined) bike.make = dto.make;
      if (dto.model !== undefined) bike.model = dto.model;
      if (dto.year !== undefined) bike.year = dto.year;
      if (dto.is_active !== undefined) bike.is_active = dto.is_active;
      if (dto.photo_url !== undefined) bike.photo_url = dto.photo_url;

      const saved = await bikeRepo.save(bike);
      return this.toDto(saved);
    });
  }

  async delete(userId: string, bikeId: string): Promise<void> {
    const result = await this.bikeRepo.delete({
      id: bikeId,
      user_id: userId,
    });
    if (result.affected === 0) throw new NotFoundException('Bike not found');
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
