import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../entities/user.entity.js';
import { UserContact } from '../../entities/user-contact.entity.js';
import { UpdateProfileDto } from './dto/update-profile.dto.js';
import { CreateContactDto } from './dto/create-contact.dto.js';
import {
  UserResponseDto,
  ContactResponseDto,
} from './dto/user-response.dto.js';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(UserContact)
    private readonly contactRepo: Repository<UserContact>,
  ) {}

  async getProfile(userId: string): Promise<UserResponseDto> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return this.toUserResponse(user);
  }

  async updateProfile(
    userId: string,
    dto: UpdateProfileDto,
  ): Promise<UserResponseDto> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (dto.display_name !== undefined) {
      user.display_name = dto.display_name;
    }
    if (dto.phone !== undefined) {
      user.phone = dto.phone;
    }
    if (dto.home_location !== undefined) {
      user.home_location = dto.home_location
        ? {
            type: 'Point',
            coordinates: [dto.home_location.lng, dto.home_location.lat],
          }
        : null;
    }
    if (dto.work_location !== undefined) {
      user.work_location = dto.work_location
        ? {
            type: 'Point',
            coordinates: [dto.work_location.lng, dto.work_location.lat],
          }
        : null;
    }
    if (dto.preferences !== undefined) {
      user.preferences = { ...user.preferences, ...dto.preferences };
    }

    const saved = await this.userRepo.save(user);
    return this.toUserResponse(saved);
  }

  async listContacts(userId: string): Promise<ContactResponseDto[]> {
    const contacts = await this.contactRepo.find({
      where: { user_id: userId },
      order: { created_at: 'DESC' },
    });
    return contacts.map((c) => this.toContactResponse(c));
  }

  async addContact(
    userId: string,
    dto: CreateContactDto,
  ): Promise<ContactResponseDto> {
    const contact = this.contactRepo.create({
      user_id: userId,
      name: dto.name,
      phone: dto.phone,
      is_emergency: dto.is_emergency ?? true,
    });
    const saved = await this.contactRepo.save(contact);
    return this.toContactResponse(saved);
  }

  async deleteContact(userId: string, contactId: string): Promise<void> {
    const contact = await this.contactRepo.findOne({
      where: { id: contactId, user_id: userId },
    });
    if (!contact) {
      throw new NotFoundException('Contact not found');
    }
    await this.contactRepo.remove(contact);
  }

  private toUserResponse(user: User): UserResponseDto {
    return {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      phone: user.phone,
      home_location: this.pointToLatLng(user.home_location),
      work_location: this.pointToLatLng(user.work_location),
      preferences: user.preferences,
      created_at: user.created_at.toISOString(),
    };
  }

  private pointToLatLng(point: unknown): { lat: number; lng: number } | null {
    if (!point) return null;
    const geo = point as { coordinates: [number, number] };
    return { lat: geo.coordinates[1], lng: geo.coordinates[0] };
  }

  private toContactResponse(contact: UserContact): ContactResponseDto {
    return {
      id: contact.id,
      name: contact.name,
      phone: contact.phone,
      is_emergency: contact.is_emergency,
      created_at: contact.created_at.toISOString(),
    };
  }
}
