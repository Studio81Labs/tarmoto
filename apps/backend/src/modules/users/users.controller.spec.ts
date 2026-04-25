/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

describe('UsersController', () => {
  let controller: UsersController;
  let service: jest.Mocked<UsersService>;

  const mockReq = {
    user: { userId: 'user-1' },
    protocol: 'https',
    get: jest.fn().mockReturnValue('api.tarmoto.test'),
  } as never;

  const mockUser = {
    id: 'user-1',
    email: 'rider@tarmoto.app',
    display_name: 'TestRider',
    phone: null,
    home_location: null,
    work_location: null,
    preferences: {},
    created_at: '2026-04-13T10:00:00.000Z',
  };

  const mockContact = {
    id: 'contact-1',
    name: 'Jane Doe',
    phone: '+420123456789',
    is_emergency: true,
    created_at: '2026-04-13T10:00:00.000Z',
  };

  beforeEach(async () => {
    const mockService = {
      getProfile: jest.fn().mockResolvedValue(mockUser),
      updateProfile: jest.fn().mockResolvedValue(mockUser),
      uploadAvatar: jest.fn().mockResolvedValue(mockUser),
      listContacts: jest.fn().mockResolvedValue([mockContact]),
      addContact: jest.fn().mockResolvedValue(mockContact),
      updateContact: jest.fn().mockResolvedValue(mockContact),
      deleteContact: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        { provide: UsersService, useValue: mockService },
        { provide: JwtService, useValue: { verifyAsync: jest.fn() } },
      ],
    }).compile();

    controller = module.get<UsersController>(UsersController);
    service = module.get(UsersService);
  });

  describe('GET /users/me', () => {
    it('should return current user profile', async () => {
      const result = await controller.getProfile(mockReq);

      expect(service.getProfile).toHaveBeenCalledWith('user-1');
      expect(result.email).toBe('rider@tarmoto.app');
    });
  });

  describe('PATCH /users/me', () => {
    it('should update and return profile', async () => {
      const dto = { display_name: 'NewName' };
      await controller.updateProfile(mockReq, dto);

      expect(service.updateProfile).toHaveBeenCalledWith('user-1', dto);
    });
  });

  describe('POST /users/me/avatar', () => {
    it('should upload an avatar and return the updated profile', async () => {
      const file = {
        originalname: 'rider.png',
        mimetype: 'image/png',
        buffer: Buffer.from('avatar'),
        size: 6,
      } as Express.Multer.File;

      await controller.uploadAvatar(mockReq, file);

      expect(service.uploadAvatar).toHaveBeenCalledWith(
        'user-1',
        file,
        'https://api.tarmoto.test',
      );
    });

    it('should reject missing files', async () => {
      await expect(controller.uploadAvatar(mockReq, undefined)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('GET /users/me/contacts', () => {
    it('should return contacts list', async () => {
      const result = await controller.listContacts(mockReq);

      expect(service.listContacts).toHaveBeenCalledWith('user-1');
      expect(result).toHaveLength(1);
    });
  });

  describe('POST /users/me/contacts', () => {
    it('should add contact', async () => {
      const dto = { name: 'Jane', phone: '+420123' };
      await controller.addContact(mockReq, dto);

      expect(service.addContact).toHaveBeenCalledWith('user-1', dto);
    });
  });

  describe('PATCH /users/me/contacts/:contactId', () => {
    it('should update contact', async () => {
      const dto = { name: 'Janet', is_emergency: false };
      await controller.updateContact(mockReq, 'contact-1', dto);

      expect(service.updateContact).toHaveBeenCalledWith(
        'user-1',
        'contact-1',
        dto,
      );
    });

    it('should propagate NotFoundException', async () => {
      service.updateContact.mockRejectedValueOnce(new NotFoundException());

      await expect(
        controller.updateContact(mockReq, 'missing', { name: 'X' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('DELETE /users/me/contacts/:contactId', () => {
    it('should delete contact', async () => {
      await controller.deleteContact(mockReq, 'contact-1');

      expect(service.deleteContact).toHaveBeenCalledWith('user-1', 'contact-1');
    });

    it('should propagate NotFoundException', async () => {
      service.deleteContact.mockRejectedValueOnce(new NotFoundException());

      await expect(
        controller.deleteContact(mockReq, 'missing'),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
