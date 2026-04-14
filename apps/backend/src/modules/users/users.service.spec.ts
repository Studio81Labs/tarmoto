/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { UsersService } from './users.service.js';
import { User } from '../../entities/user.entity.js';
import { UserContact } from '../../entities/user-contact.entity.js';

describe('UsersService', () => {
  let service: UsersService;
  let userRepo: jest.Mocked<Partial<Repository<User>>>;
  let contactRepo: jest.Mocked<Partial<Repository<UserContact>>>;

  const mockUser = {
    id: 'user-1',
    email: 'rider@tarmoto.app',
    display_name: 'TestRider',
    phone: null,
    home_location: null,
    work_location: null,
    preferences: { units: 'metric' },
    created_at: new Date('2026-04-13T10:00:00Z'),
    updated_at: new Date('2026-04-13T10:00:00Z'),
  } as User;

  const mockContact = {
    id: 'contact-1',
    user_id: 'user-1',
    name: 'Jane Doe',
    phone: '+420123456789',
    is_emergency: true,
    created_at: new Date('2026-04-13T10:00:00Z'),
  } as UserContact;

  beforeEach(async () => {
    userRepo = {
      findOne: jest.fn().mockResolvedValue(mockUser),
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
        ...mockUser,
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

    it('should throw NotFoundException for missing user', async () => {
      userRepo.findOne!.mockResolvedValueOnce(null);

      await expect(
        service.updateProfile('missing', { display_name: 'X' }),
      ).rejects.toThrow(NotFoundException);
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
