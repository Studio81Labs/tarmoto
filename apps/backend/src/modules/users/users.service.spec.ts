/* eslint-disable @typescript-eslint/no-unsafe-return */
jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn(),
  unlink: jest.fn(),
  writeFile: jest.fn(),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { unlink, writeFile, mkdir } from 'node:fs/promises';
import { UsersService } from './users.service.js';
import { User } from '../../entities/user.entity.js';
import { UserContact } from '../../entities/user-contact.entity.js';

describe('UsersService', () => {
  let service: UsersService;
  let userRepo: Partial<jest.Mocked<Repository<User>>>;
  let contactRepo: Partial<jest.Mocked<Repository<UserContact>>>;

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
    jest.mocked(mkdir).mockResolvedValue(undefined);
    jest.mocked(unlink).mockResolvedValue(undefined);
    jest.mocked(writeFile).mockResolvedValue(undefined);

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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: getRepositoryToken(UserContact), useValue: contactRepo },
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

      expect(unlink).not.toHaveBeenCalled();
    });
  });

  describe('uploadAvatar', () => {
    const file = {
      mimetype: 'image/png',
      buffer: Buffer.from('avatar-bytes'),
    } as Express.Multer.File;

    it('should store the uploaded avatar and remove the previous managed file', async () => {
      userRepo.findOne!.mockResolvedValueOnce({
        ...buildMockUser(),
        avatar_url: 'https://app.tarmoto.test/uploads/avatars/old-avatar.png',
      } as User);

      const result = await service.uploadAvatar(
        'user-1',
        file,
        'https://app.tarmoto.test',
      );

      expect(writeFile).toHaveBeenCalledWith(
        expect.stringContaining('/uploads/avatars/user-1-'),
        file.buffer,
      );
      const savedUser = userRepo.save!.mock.calls[0]?.[0] as User;
      expect(savedUser.avatar_url).toMatch(
        /^https:\/\/app\.tarmoto\.test\/uploads\/avatars\/user-1-/,
      );
      expect(unlink).toHaveBeenCalledWith(
        expect.stringContaining('/uploads/avatars/old-avatar.png'),
      );
      expect(result.avatar_url).toMatch(
        /^https:\/\/app\.tarmoto\.test\/uploads\/avatars\/user-1-/,
      );
    });

    it('should not delete the new avatar file when removing the previous avatar fails after save', async () => {
      userRepo.findOne!.mockResolvedValueOnce({
        ...buildMockUser(),
        avatar_url: 'https://app.tarmoto.test/uploads/avatars/old-avatar.png',
      } as User);
      jest
        .mocked(unlink)
        .mockRejectedValueOnce(
          Object.assign(new Error('permission denied'), { code: 'EACCES' }),
        );

      await expect(
        service.uploadAvatar('user-1', file, 'https://app.tarmoto.test'),
      ).rejects.toThrow('permission denied');

      expect(unlink).toHaveBeenCalledTimes(1);
      expect(unlink).toHaveBeenCalledWith(
        expect.stringContaining('/uploads/avatars/old-avatar.png'),
      );
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
