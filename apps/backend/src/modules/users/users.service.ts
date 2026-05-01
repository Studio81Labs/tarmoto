import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { pointToLatLng } from '@tarmoto/shared';
import { User } from '../../entities/user.entity.js';
import { UserContact } from '../../entities/user-contact.entity.js';
import { UserFollow } from '../../entities/user-follow.entity.js';
import { OBJECT_STORAGE } from '../storage/storage.tokens.js';
import type { ObjectStorage } from '../storage/object-storage.interface.js';
import { UpdateProfileDto } from './dto/update-profile.dto.js';
import { CreateContactDto } from './dto/create-contact.dto.js';
import { UpdateContactDto } from './dto/update-contact.dto.js';
import {
  UserResponseDto,
  ContactResponseDto,
} from './dto/user-response.dto.js';
import { PublicProfileDto } from './dto/public-profile.dto.js';
import { AVATAR_KEY_PREFIX, avatarKeyFromUrl } from './avatar-storage-key.js';

const ALLOWED_AVATAR_TYPES = new Map<string, string>([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(UserContact)
    private readonly contactRepo: Repository<UserContact>,
    @InjectRepository(UserFollow)
    private readonly userFollowRepo: Repository<UserFollow>,
    @Inject(OBJECT_STORAGE)
    private readonly storage: ObjectStorage,
  ) {}

  async getProfile(userId: string): Promise<UserResponseDto> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return this.toUserResponse(user);
  }

  /**
   * Public-facing rider profile (US-27). Loads display fields, denormalised
   * follower/following counts, and the viewer's `is_following` flag in one
   * trip so the mobile screen doesn't need three round trips on render.
   *
   * `is_following` is `null` when `viewerId === userId` so the client can
   * hide the follow button instead of mistakenly defaulting it to "Follow".
   * 404 covers both a missing row and a soft-deleted user — public profiles
   * shouldn't leak the difference.
   */
  async getPublicProfile(
    viewerId: string,
    userId: string,
  ): Promise<PublicProfileDto> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user || user.deleted_at != null) {
      throw new NotFoundException('User not found');
    }

    const isSelf = viewerId === userId;
    const [followerCount, followingCount, isFollowingRow] = await Promise.all([
      this.userFollowRepo.count({ where: { following_id: userId } }),
      this.userFollowRepo.count({ where: { follower_id: userId } }),
      isSelf
        ? Promise.resolve(null)
        : this.userFollowRepo.findOne({
            where: { follower_id: viewerId, following_id: userId },
            select: ['follower_id'],
          }),
    ]);

    return {
      id: user.id,
      display_name: user.display_name,
      avatar_url: user.avatar_url,
      bio: user.bio,
      home_region: user.home_region,
      created_at: user.created_at.toISOString(),
      follower_count: followerCount,
      following_count: followingCount,
      is_following: isSelf ? null : isFollowingRow != null,
      is_self: isSelf,
    };
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
      await this.deleteManagedAvatar(previousAvatarUrl);
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

    const filename = `${userId}-${Date.now()}-${randomUUID()}${extension}`;
    const key = `${AVATAR_KEY_PREFIX}${filename}`;
    const previousAvatarUrl = user.avatar_url;

    await this.storage.put({
      key,
      body: file.buffer,
      contentType: file.mimetype,
    });
    // Storage returns either a server-relative path (LocalStorage —
    // depends on the API host the client hits) or an absolute CDN
    // URL (S3 — already self-contained). Mobile / companion clients
    // pass the value straight to `<Image source={{ uri }} />`, which
    // does NOT auto-resolve relative URLs, so we lift the relative
    // form into an absolute one against the request's public base
    // URL before storing. Absolute URLs are preserved verbatim.
    const storageUrl = this.storage.publicUrl(key);
    const nextAvatarUrl = /^https?:\/\//.test(storageUrl)
      ? storageUrl
      : `${publicBaseUrl}${storageUrl}`;

    let saved: User;
    try {
      user.avatar_url = nextAvatarUrl;
      saved = await this.userRepo.save(user);
    } catch (error) {
      // Save failed after the new object landed: roll back the
      // upload so we don't accumulate orphaned avatars on every
      // failed DB write. Wrapped in a best-effort catch — the
      // original save error is what the caller cares about.
      await this.deleteManagedAvatar(nextAvatarUrl).catch(() => {});
      throw error;
    }

    // Save succeeded — the user's profile already points at the new
    // avatar. Removing the previous object is a cleanup of orphaned
    // bytes; a transient failure here (S3 5xx, transient FS error)
    // shouldn't turn into a 500 for an upload that, from the
    // caller's perspective, already completed. Log and move on so
    // the next upload (or a future GC sweep) gets another shot.
    try {
      await this.deleteManagedAvatar(previousAvatarUrl);
    } catch (error) {
      this.logger.warn(
        `Failed to clean up previous avatar for user ${userId}: ${
          (error as Error).message
        }`,
      );
    }
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

  private async deleteManagedAvatar(avatarUrl: string | null): Promise<void> {
    const key = avatarKeyFromUrl(avatarUrl);
    if (!key) return;
    await this.storage.delete(key);
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
