/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Logger, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Readable } from 'node:stream';
import { UsersService } from './users.service.js';
import { User } from '../../entities/user.entity.js';
import { UserContact } from '../../entities/user-contact.entity.js';
import { UserFollow } from '../../entities/user-follow.entity.js';
import { OBJECT_STORAGE } from '../storage/storage.tokens.js';
import type { ObjectStorage } from '../storage/object-storage.interface.js';

describe('UsersService', () => {
  let service: UsersService;
  let userRepo: Partial<jest.Mocked<Repository<User>>>;
  let contactRepo: Partial<jest.Mocked<Repository<UserContact>>>;
  let userFollowRepo: Partial<jest.Mocked<Repository<UserFollow>>>;
  let storage: jest.Mocked<ObjectStorage>;

  // Factory, not a shared instance — updateProfile mutates the entity it
  // loads via findOne, so any two tests sharing the same object would leak
  // state (and make ordering matter).
  const buildMockUser = (): User =>
    ({
      id: 'user-1',
      email: 'rider@tarmoto.app',
      display_name: 'TestRider',
      phone: null,
      avatar_url: null,
      bio: null,
      home_region: null,
      home_location: null,
      work_location: null,
      preferences: { units: 'metric' },
      created_at: new Date('2026-04-13T10:00:00Z'),
      updated_at: new Date('2026-04-13T10:00:00Z'),
    }) as unknown as User;

  const mockContact = {
    id: 'contact-1',
    user_id: 'user-1',
    name: 'Jane Doe',
    phone: '+420123456789',
    is_emergency: true,
    created_at: new Date('2026-04-13T10:00:00Z'),
  } as UserContact;

  beforeEach(async () => {
    jest.clearAllMocks();

    storage = {
      put: jest.fn().mockResolvedValue({ byteSize: 12 }),
      read: jest.fn().mockResolvedValue(Readable.from(Buffer.from(''))),
      delete: jest.fn().mockResolvedValue(undefined),
      exists: jest.fn().mockResolvedValue(true),
      // Default: build a relative LocalStorage-style URL from the
      // key so tests can assert on either the key or the URL.
      publicUrl: jest
        .fn()
        .mockImplementation((key: string) => `/uploads/${key}`),
      signedUrl: jest
        .fn()
        .mockImplementation((key: string) =>
          Promise.resolve(`/uploads/${key}`),
        ),
    } as unknown as jest.Mocked<ObjectStorage>;

    userRepo = {
      findOne: jest
        .fn()
        .mockImplementation(() => Promise.resolve(buildMockUser())),
      save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
    };
    contactRepo = {
      find: jest.fn().mockResolvedValue([mockContact]),
      findOne: jest.fn().mockResolvedValue(mockContact),
      create: jest
        .fn()
        .mockImplementation((data) => ({ ...mockContact, ...data })),
      save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    userFollowRepo = {
      count: jest.fn().mockResolvedValue(0),
      findOne: jest.fn().mockResolvedValue(null),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: getRepositoryToken(UserContact), useValue: contactRepo },
        { provide: getRepositoryToken(UserFollow), useValue: userFollowRepo },
        { provide: OBJECT_STORAGE, useValue: storage },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  describe('getProfile', () => {
    it('should return user profile', async () => {
      const result = await service.getProfile('user-1');

      expect(result.id).toBe('user-1');
      expect(result.email).toBe('rider@tarmoto.app');
      expect(result.display_name).toBe('TestRider');
      expect(result.home_location).toBeNull();
    });

    it('should throw NotFoundException for missing user', async () => {
      userRepo.findOne!.mockResolvedValueOnce(null);

      await expect(service.getProfile('missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should convert geometry Point to lat/lng', async () => {
      userRepo.findOne!.mockResolvedValueOnce({
        ...buildMockUser(),
        home_location: { type: 'Point', coordinates: [16.75, 49.1] },
      } as User);

      const result = await service.getProfile('user-1');

      expect(result.home_location).toEqual({ lat: 49.1, lng: 16.75 });
    });
  });

  describe('getPublicProfile', () => {
    it('returns counts and is_following=true when viewer follows target', async () => {
      userFollowRepo.count!.mockResolvedValueOnce(7).mockResolvedValueOnce(3);
      userFollowRepo.findOne!.mockResolvedValueOnce({
        follower_id: 'viewer-1',
      } as UserFollow);

      const result = await service.getPublicProfile('viewer-1', 'user-1');

      expect(result).toEqual({
        id: 'user-1',
        display_name: 'TestRider',
        avatar_url: null,
        bio: null,
        home_region: null,
        created_at: '2026-04-13T10:00:00.000Z',
        follower_count: 7,
        following_count: 3,
        is_following: true,
        is_self: false,
      });
    });

    it('returns is_following=false when viewer does not follow target', async () => {
      userFollowRepo.count!.mockResolvedValueOnce(2).mockResolvedValueOnce(0);
      userFollowRepo.findOne!.mockResolvedValueOnce(null);

      const result = await service.getPublicProfile('viewer-1', 'user-1');

      expect(result.is_following).toBe(false);
      expect(result.is_self).toBe(false);
      expect(result.follower_count).toBe(2);
      expect(result.following_count).toBe(0);
    });

    it('returns is_following=null and is_self=true when viewing own profile', async () => {
      userFollowRepo.count!.mockResolvedValueOnce(5).mockResolvedValueOnce(11);

      const result = await service.getPublicProfile('user-1', 'user-1');

      expect(result.is_following).toBeNull();
      expect(result.is_self).toBe(true);
      // Self check short-circuits the follow lookup so we don't waste a query.
      expect(userFollowRepo.findOne).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for missing user', async () => {
      userRepo.findOne!.mockResolvedValueOnce(null);

      await expect(
        service.getPublicProfile('viewer-1', 'missing'),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException for soft-deleted user', async () => {
      userRepo.findOne!.mockResolvedValueOnce({
        ...buildMockUser(),
        deleted_at: new Date('2026-04-30T10:00:00Z'),
      } as User);

      await expect(
        service.getPublicProfile('viewer-1', 'user-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateProfile', () => {
    it('should update display_name', async () => {
      const result = await service.updateProfile('user-1', {
        display_name: 'NewName',
      });

      expect(userRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ display_name: 'NewName' }),
      );
      expect(result.display_name).toBe('NewName');
    });

    it('should update phone', async () => {
      await service.updateProfile('user-1', { phone: '+420999888777' });

      expect(userRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ phone: '+420999888777' }),
      );
    });

    it('should convert home_location to Point geometry', async () => {
      await service.updateProfile('user-1', {
        home_location: { lat: 49.1, lng: 16.75 },
      });

      expect(userRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          home_location: {
            type: 'Point',
            coordinates: [16.75, 49.1],
          },
        }),
      );
    });

    it('should clear home_location when null is sent', async () => {
      await service.updateProfile('user-1', {
        home_location: null as never,
      });

      expect(userRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ home_location: null }),
      );
    });

    it('should clear work_location when null is sent', async () => {
      await service.updateProfile('user-1', {
        work_location: null as never,
      });

      expect(userRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ work_location: null }),
      );
    });

    it('should merge preferences', async () => {
      await service.updateProfile('user-1', {
        preferences: { daily_km: 300 },
      });

      expect(userRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          preferences: { units: 'metric', daily_km: 300 },
        }),
      );
    });

    it('should update avatar_url, bio, and home_region together', async () => {
      const result = await service.updateProfile('user-1', {
        avatar_url: 'https://cdn.example.com/u/1.png',
        bio: 'Weekend rider, Beskydy regular.',
        home_region: 'Beskydy, Czech Republic',
      });

      expect(userRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          avatar_url: 'https://cdn.example.com/u/1.png',
          bio: 'Weekend rider, Beskydy regular.',
          home_region: 'Beskydy, Czech Republic',
        }),
      );
      expect(result.avatar_url).toBe('https://cdn.example.com/u/1.png');
      expect(result.bio).toBe('Weekend rider, Beskydy regular.');
      expect(result.home_region).toBe('Beskydy, Czech Republic');
    });

    it('should clear bio and home_region when null is sent', async () => {
      await service.updateProfile('user-1', {
        bio: null,
        home_region: null,
        avatar_url: null,
      });

      expect(userRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          bio: null,
          home_region: null,
          avatar_url: null,
        }),
      );
    });

    it('should leave profile fields untouched when the dto omits them', async () => {
      await service.updateProfile('user-1', { display_name: 'OnlyName' });

      const saved = userRepo.save!.mock.calls[0][0] as Record<string, unknown>;
      // The DTO omits these keys, so the service must leave the fixture's
      // values (null, from buildMockUser) intact — not blank them or
      // replace them with undefined / empty strings.
      expect(saved.avatar_url).toBeNull();
      expect(saved.bio).toBeNull();
      expect(saved.home_region).toBeNull();
    });

    it('should throw NotFoundException for missing user', async () => {
      userRepo.findOne!.mockResolvedValueOnce(null);

      await expect(
        service.updateProfile('missing', { display_name: 'X' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should not delete files outside the managed avatar upload directory', async () => {
      userRepo.findOne!.mockResolvedValueOnce({
        ...buildMockUser(),
        avatar_url: '/uploads/avatars/..%2F..%2Fsecrets.txt',
      } as User);

      await service.updateProfile('user-1', {
        avatar_url: 'https://cdn.example.com/u/1.png',
      });

      expect(storage.delete).not.toHaveBeenCalled();
    });

    it('should ignore decoded avatar filenames with null bytes', async () => {
      userRepo.findOne!.mockResolvedValueOnce({
        ...buildMockUser(),
        avatar_url: '/uploads/avatars/%00avatar.png',
      } as User);

      await service.updateProfile('user-1', {
        avatar_url: 'https://cdn.example.com/u/1.png',
      });

      expect(storage.delete).not.toHaveBeenCalled();
    });

    it('should ignore decoded avatar filenames that resolve to dot segments', async () => {
      userRepo.findOne!.mockResolvedValueOnce({
        ...buildMockUser(),
        avatar_url: '/uploads/avatars/%2e%2e',
      } as User);

      await service.updateProfile('user-1', {
        avatar_url: 'https://cdn.example.com/u/1.png',
      });

      expect(storage.delete).not.toHaveBeenCalled();
    });
  });

  describe('uploadAvatar', () => {
    const file = {
      mimetype: 'image/png',
      buffer: Buffer.from('avatar-bytes'),
    } as Express.Multer.File;

    it('writes the uploaded avatar via the storage backend and embeds an absolute URL built from the request base URL', async () => {
      userRepo.findOne!.mockResolvedValueOnce({
        ...buildMockUser(),
        avatar_url: 'https://app.tarmoto.test/uploads/avatars/old-avatar.png',
      } as User);

      const result = await service.uploadAvatar(
        'user-1',
        file,
        'https://app.tarmoto.test',
      );

      // The new avatar lands in storage under `avatars/<userId>-...`
      // — we don't pin the random filename, just the prefix and
      // content type contract.
      expect(storage.put).toHaveBeenCalledTimes(1);
      const putArg = storage.put.mock.calls[0][0];
      expect(putArg.key).toMatch(/^avatars\/user-1-\d+-[0-9a-f-]+\.png$/);
      expect(putArg.body).toBe(file.buffer);
      expect(putArg.contentType).toBe('image/png');

      // For LocalStorage-style relative URLs, the service prefixes
      // the request's public base so mobile clients (which don't
      // resolve relative URLs) can render the image directly.
      const savedUser = userRepo.save!.mock.calls[0]?.[0] as User;
      expect(savedUser.avatar_url).toMatch(
        /^https:\/\/app\.tarmoto\.test\/uploads\/avatars\/user-1-/,
      );
      expect(result.avatar_url).toMatch(
        /^https:\/\/app\.tarmoto\.test\/uploads\/avatars\/user-1-/,
      );

      // The old avatar is removed by storage key, not by absolute
      // path — the storage-key helper turns the legacy URL into a
      // managed key.
      expect(storage.delete).toHaveBeenCalledWith('avatars/old-avatar.png');
    });

    it('preserves an absolute URL returned by the storage backend (S3 / CDN case)', async () => {
      userRepo.findOne!.mockResolvedValueOnce({
        ...buildMockUser(),
        avatar_url: null,
      } as User);
      // S3Storage returns an absolute URL. The service should use
      // it verbatim — prefixing the request base URL would yield
      // an obvious nonsense double-host.
      storage.publicUrl.mockImplementationOnce(
        (key: string) => `https://cdn.tarmoto.app/${key}`,
      );

      const result = await service.uploadAvatar(
        'user-1',
        file,
        'https://app.tarmoto.test',
      );

      expect(result.avatar_url).toMatch(
        /^https:\/\/cdn\.tarmoto\.app\/avatars\/user-1-/,
      );
    });

    it('rejects an unsupported MIME type before calling storage', async () => {
      const badFile = {
        mimetype: 'image/gif',
        buffer: Buffer.from('gif87a'),
      } as Express.Multer.File;

      await expect(
        service.uploadAvatar('user-1', badFile, 'https://app.tarmoto.test'),
      ).rejects.toThrow(/PNG, JPEG, or WebP/);
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('returns the updated profile when the previous-avatar cleanup fails after save (best-effort, logged)', async () => {
      userRepo.findOne!.mockResolvedValueOnce({
        ...buildMockUser(),
        avatar_url: 'https://app.tarmoto.test/uploads/avatars/old-avatar.png',
      } as User);
      // From the caller's perspective the upload already succeeded —
      // the row is saved, the new object is in storage. A flaky
      // delete of the now-orphaned previous object must NOT turn
      // into a 500. Suppress logger output so the test isn't noisy.
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      storage.delete.mockRejectedValueOnce(
        Object.assign(new Error('permission denied'), { code: 'EACCES' }),
      );

      const result = await service.uploadAvatar(
        'user-1',
        file,
        'https://app.tarmoto.test',
      );

      expect(result.avatar_url).toMatch(
        /^https:\/\/app\.tarmoto\.test\/uploads\/avatars\/user-1-/,
      );
      // Exactly one delete: the old avatar. The new one stays put.
      expect(storage.delete).toHaveBeenCalledTimes(1);
      expect(storage.delete).toHaveBeenCalledWith('avatars/old-avatar.png');
      // The failure is observable in logs so an operator can spot
      // a leaking-cleanup pattern.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to clean up previous avatar'),
      );
      warnSpy.mockRestore();
    });

    it('rolls back the new object when the DB save fails', async () => {
      userRepo.findOne!.mockResolvedValueOnce({
        ...buildMockUser(),
        avatar_url: null,
      } as User);
      userRepo.save!.mockRejectedValueOnce(new Error('db down'));

      await expect(
        service.uploadAvatar('user-1', file, 'https://app.tarmoto.test'),
      ).rejects.toThrow('db down');

      // The just-uploaded avatar is best-effort deleted so a
      // failed save doesn't leak orphaned objects on every retry.
      expect(storage.delete).toHaveBeenCalledTimes(1);
      const deletedKey = storage.delete.mock.calls[0][0];
      expect(deletedKey).toMatch(/^avatars\/user-1-/);
    });
  });

  describe('listContacts', () => {
    it('should return contacts for user', async () => {
      const result = await service.listContacts('user-1');

      expect(contactRepo.find).toHaveBeenCalledWith({
        where: { user_id: 'user-1' },
        order: { created_at: 'DESC' },
      });
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Jane Doe');
      expect(result[0].is_emergency).toBe(true);
    });
  });

  describe('addContact', () => {
    it('should create contact with default is_emergency=true', async () => {
      const result = await service.addContact('user-1', {
        name: 'John',
        phone: '+420111222333',
      });

      expect(contactRepo.create).toHaveBeenCalledWith({
        user_id: 'user-1',
        name: 'John',
        phone: '+420111222333',
        is_emergency: true,
      });
      expect(result.name).toBe('John');
    });

    it('should respect explicit is_emergency=false', async () => {
      await service.addContact('user-1', {
        name: 'Bob',
        phone: '+420999',
        is_emergency: false,
      });

      expect(contactRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ is_emergency: false }),
      );
    });
  });

  describe('updateContact', () => {
    it('should update name only when name is provided', async () => {
      const result = await service.updateContact('user-1', 'contact-1', {
        name: 'Janet',
      });

      expect(contactRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'contact-1', user_id: 'user-1' },
      });
      expect(contactRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'contact-1',
          name: 'Janet',
          phone: '+420123456789',
          is_emergency: true,
        }),
      );
      expect(result.name).toBe('Janet');
    });

    it('should update is_emergency=false', async () => {
      await service.updateContact('user-1', 'contact-1', {
        is_emergency: false,
      });

      expect(contactRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ is_emergency: false }),
      );
    });

    it('should throw NotFoundException for missing contact', async () => {
      contactRepo.findOne!.mockResolvedValueOnce(null);

      await expect(
        service.updateContact('user-1', 'missing', { name: 'X' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should not update contact belonging to another user', async () => {
      contactRepo.findOne!.mockResolvedValueOnce(null);

      await expect(
        service.updateContact('other-user', 'contact-1', { name: 'X' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteContact', () => {
    it('should delete contact belonging to user', async () => {
      await service.deleteContact('user-1', 'contact-1');

      expect(contactRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'contact-1', user_id: 'user-1' },
      });
      expect(contactRepo.remove).toHaveBeenCalledWith(mockContact);
    });

    it('should throw NotFoundException for missing contact', async () => {
      contactRepo.findOne!.mockResolvedValueOnce(null);

      await expect(service.deleteContact('user-1', 'missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should not delete contact belonging to another user', async () => {
      contactRepo.findOne!.mockResolvedValueOnce(null);

      await expect(
        service.deleteContact('other-user', 'contact-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
