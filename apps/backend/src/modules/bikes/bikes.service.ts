import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Bike } from '../../entities/bike.entity.js';
import { CreateBikeDto, UpdateBikeDto, BikeDto } from './dto/bike.dto.js';

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

    // First bike is always active; explicit active flag also deactivates others.
    const shouldActivate = isFirst || dto.is_active;
    if (shouldActivate) {
      await this.bikeRepo.update({ user_id: userId }, { is_active: false });
    }

    const bike = this.bikeRepo.create({
      user_id: userId,
      make: dto.make,
      model: dto.model,
      year: dto.year ?? null,
      is_active: shouldActivate,
      photo_url: dto.photo_url ?? null,
    });
    const saved = await this.bikeRepo.save(bike);
    return this.toDto(saved);
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
      await this.bikeRepo.update({ user_id: userId }, { is_active: false });
    }

    Object.assign(bike, dto);
    const saved = await this.bikeRepo.save(bike);
    return this.toDto(saved);
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
      is_active: b.is_active,
      photo_url: b.photo_url ?? null,
      total_km: 0,
      total_rides: 0,
      created_at: b.created_at.toISOString(),
      updated_at: b.updated_at.toISOString(),
    };
  }
}
