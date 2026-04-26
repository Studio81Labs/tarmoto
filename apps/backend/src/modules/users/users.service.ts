import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pointToLatLng } from '@tarmoto/shared';
import { User } from '../../entities/user.entity.js';
import { UserContact } from '../../entities/user-contact.entity.js';
import { UpdateProfileDto } from './dto/update-profile.dto.js';
import { CreateContactDto } from './dto/create-contact.dto.js';
import { UpdateContactDto } from './dto/update-contact.dto.js';
import {
  UserResponseDto,
  ContactResponseDto,
} from './dto/user-response.dto.js';

const AVATAR_PATH_PREFIX = '/uploads/avatars/';
const AVATAR_UPLOAD_DIR = join(process.cwd(), 'uploads', 'avatars');
const ALLOWED_AVATAR_TYPES = new Map<string, string>([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function managedAvatarFilePath(avatarUrl: string | null): string | null {
  if (!avatarUrl) return null;

  try {
    const parsed = new URL(avatarUrl, 'https://tarmoto.local');
    if (!parsed.pathname.startsWith(AVATAR_PATH_PREFIX)) return null;

    const encodedFilename = parsed.pathname.slice(AVATAR_PATH_PREFIX.length);
    if (!encodedFilename) return null;

    const filename = decodeURIComponent(encodedFilename);
    if (
      filename === '.' ||
      filename === '..' ||
      filename !== basename(filename) ||
      filename.includes('/') ||
      filename.includes('\\') ||
      hasControlCharacters(filename)
    ) {
      return null;
    }

    return join(AVATAR_UPLOAD_DIR, filename);
  } catch {
    return null;
  }
}

async function deleteManagedAvatar(avatarUrl: string | null): Promise<void> {
  const filePath = managedAvatarFilePath(avatarUrl);
  if (!filePath) return;

  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

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
    const previousAvatarUrl = user.avatar_url;

    if (dto.display_name !== undefined) {
      user.display_name = dto.display_name;
    }
    if (dto.phone !== undefined) {
      user.phone = dto.phone;
    }
    if (dto.avatar_url !== undefined) {
      user.avatar_url = dto.avatar_url;
    }
    if (dto.bio !== undefined) {
      user.bio = dto.bio;
    }
    if (dto.home_region !== undefined) {
      user.home_region = dto.home_region;
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
    if (
      dto.avatar_url !== undefined &&
      previousAvatarUrl !== saved.avatar_url
    ) {
      await deleteManagedAvatar(previousAvatarUrl);
    }
    return this.toUserResponse(saved);
  }

  async uploadAvatar(
    userId: string,
    file: Express.Multer.File,
    publicBaseUrl: string,
  ): Promise<UserResponseDto> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const extension = ALLOWED_AVATAR_TYPES.get(file.mimetype);
    if (!extension) {
      throw new BadRequestException(
        'Avatar must be a PNG, JPEG, or WebP image',
      );
    }

    await mkdir(AVATAR_UPLOAD_DIR, { recursive: true });
    const filename = `${userId}-${Date.now()}-${randomUUID()}${extension}`;
    const filePath = join(AVATAR_UPLOAD_DIR, filename);
    const previousAvatarUrl = user.avatar_url;
    const nextAvatarUrl = `${publicBaseUrl}${AVATAR_PATH_PREFIX}${filename}`;

    await writeFile(filePath, file.buffer);

    let saved: User;
    try {
      user.avatar_url = nextAvatarUrl;
      saved = await this.userRepo.save(user);
    } catch (error) {
      await deleteManagedAvatar(nextAvatarUrl);
      throw error;
    }

    await deleteManagedAvatar(previousAvatarUrl);
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

  async updateContact(
    userId: string,
    contactId: string,
    dto: UpdateContactDto,
  ): Promise<ContactResponseDto> {
    const contact = await this.contactRepo.findOne({
      where: { id: contactId, user_id: userId },
    });
    if (!contact) {
      throw new NotFoundException('Contact not found');
    }
    if (dto.name !== undefined) {
      contact.name = dto.name;
    }
    if (dto.phone !== undefined) {
      contact.phone = dto.phone;
    }
    if (dto.is_emergency !== undefined) {
      contact.is_emergency = dto.is_emergency;
    }
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
      avatar_url: user.avatar_url,
      bio: user.bio,
      home_region: user.home_region,
      home_location: pointToLatLng(user.home_location),
      work_location: pointToLatLng(user.work_location),
      preferences: user.preferences,
      created_at: user.created_at.toISOString(),
    };
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
