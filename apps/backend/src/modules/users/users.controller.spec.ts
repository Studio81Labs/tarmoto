import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { authGuardTestProviders } from '../auth/auth-test-providers.js';
import { SharingService } from '../sharing/sharing.service.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

describe('UsersController', () => {
  let controller: UsersController;
  let service: jest.Mocked<UsersService>;
  let sharingService: jest.Mocked<SharingService>;

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

  const mockPublicProfile = {
    id: 'user-2',
    display_name: 'OtherRider',
    avatar_url: null,
    bio: null,
    home_region: null,
    created_at: '2026-04-13T10:00:00.000Z',
    follower_count: 4,
    following_count: 2,
    is_following: false,
    follows_you: false,
    is_self: false,
  };

  const mockMeProfile = {
    joined_at: '2026-04-13T10:00:00.000Z',
    total_hours: 42.5,
    total_rides: 18,
    total_distance_km: 1234.5,
    roads_discovered: 73,
    hazards_reported: 6,
    follower_count: 11,
    following_count: 7,
    badges_earned: 5,
  };

  const mockSharedRidesResponse = {
    items: [
      {
        id: 'ride-1',
        share_token: 'tok-1',
        ride_type: 'free',
        is_public: true,
        started_at: '2026-04-14T09:00:00.000Z',
        ended_at: '2026-04-14T10:30:00.000Z',
        distance_km: 42.5,
        avg_speed: 65.3,
        avg_road_quality: 4.2,
        avg_curviness: 3.1,
        duration_min: 90,
        view_count: 7,
        shared_at: '2026-04-14T11:00:00.000Z',
        route_geometry: null,
      },
    ],
    total: 1,
    limit: 20,
    offset: 0,
  };

  // Per-test config override for `TARMOTO_PUBLIC_BASE_URL` and
  // `NODE_ENV`. Tests reach into this and call `set()` to
  // simulate prod / configured-base-url scenarios.
  const env: Record<string, string | undefined> = {};
  const setEnv = (next: Record<string, string | undefined>) => {
    for (const k of Object.keys(env)) delete env[k];
    Object.assign(env, next);
  };
  const mockConfigService = {
    get: jest.fn(<T>(key: string): T | undefined => env[key] as T | undefined),
  };

  beforeEach(async () => {
    setEnv({});
    delete process.env.NODE_ENV;
    const mockService = {
      getProfile: jest.fn().mockResolvedValue(mockUser),
      getMeProfile: jest.fn().mockResolvedValue(mockMeProfile),
      getPublicProfile: jest.fn().mockResolvedValue(mockPublicProfile),
      updateProfile: jest.fn().mockResolvedValue(mockUser),
      uploadAvatar: jest.fn().mockResolvedValue(mockUser),
      listContacts: jest.fn().mockResolvedValue([mockContact]),
      addContact: jest.fn().mockResolvedValue(mockContact),
      updateContact: jest.fn().mockResolvedValue(mockContact),
      deleteContact: jest.fn().mockResolvedValue(undefined),
    };
    const mockSharingService = {
      listForUser: jest.fn().mockResolvedValue(mockSharedRidesResponse),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        { provide: UsersService, useValue: mockService },
        { provide: SharingService, useValue: mockSharingService },
        { provide: ConfigService, useValue: mockConfigService },
        ...authGuardTestProviders,
      ],
    }).compile();

    controller = module.get<UsersController>(UsersController);
    service = module.get(UsersService);
    sharingService = module.get(SharingService);
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

  describe('GET /users/me/profile', () => {
    it('returns the rider summary for the authenticated user', async () => {
      const result = await controller.getMeProfile(mockReq);

      expect(service.getMeProfile).toHaveBeenCalledWith('user-1');
      expect(result.total_hours).toBe(42.5);
      expect(result.joined_at).toBe('2026-04-13T10:00:00.000Z');
      expect(result.badges_earned).toBe(5);
    });
  });

  describe('GET /users/:userId/profile', () => {
    it('passes the viewer id and target id through to the service', async () => {
      const result = await controller.getPublicProfile(mockReq, 'user-2');

      expect(service.getPublicProfile).toHaveBeenCalledWith('user-1', 'user-2');
      expect(result.display_name).toBe('OtherRider');
    });

    it('propagates NotFoundException for missing target', async () => {
      service.getPublicProfile.mockRejectedValueOnce(new NotFoundException());

      await expect(
        controller.getPublicProfile(mockReq, 'missing-user'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('GET /users/:userId/shared-rides', () => {
    it('passes the viewer id, target id, and query through to the sharing service', async () => {
      const result = await controller.listSharedRides(mockReq, 'user-2', {
        limit: 10,
        offset: 5,
      });

      expect(sharingService.listForUser).toHaveBeenCalledWith(
        'user-1',
        'user-2',
        { limit: 10, offset: 5 },
      );
      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('uses defaults when no query parameters are supplied', async () => {
      await controller.listSharedRides(mockReq, 'user-2', {});

      expect(sharingService.listForUser).toHaveBeenCalledWith(
        'user-1',
        'user-2',
        {},
      );
    });

    it('propagates NotFoundException for missing or hidden riders', async () => {
      sharingService.listForUser.mockRejectedValueOnce(new NotFoundException());

      await expect(
        controller.listSharedRides(mockReq, 'missing-user', {}),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('POST /users/me/avatar', () => {
    const file = {
      originalname: 'rider.png',
      mimetype: 'image/png',
      buffer: Buffer.from('avatar'),
      size: 6,
    } as Express.Multer.File;

    it('falls back to the request-derived origin when TARMOTO_PUBLIC_BASE_URL is unset (dev)', async () => {
      await controller.uploadAvatar(mockReq, file);

      expect(service.uploadAvatar).toHaveBeenCalledWith(
        'user-1',
        file,
        'https://api.tarmoto.test',
      );
    });

    it('prefers TARMOTO_PUBLIC_BASE_URL over the request-derived origin', async () => {
      // Behind a reverse proxy `req.get('host')` may report an
      // internal pod hostname; the configured base URL is the one
      // mobile clients can resolve, so it must win when set.
      setEnv({ TARMOTO_PUBLIC_BASE_URL: 'https://api.tarmoto.app' });

      await controller.uploadAvatar(mockReq, file);

      expect(service.uploadAvatar).toHaveBeenCalledWith(
        'user-1',
        file,
        'https://api.tarmoto.app',
      );
    });

    it('strips a trailing slash from TARMOTO_PUBLIC_BASE_URL so URLs concatenate cleanly', async () => {
      setEnv({ TARMOTO_PUBLIC_BASE_URL: 'https://api.tarmoto.app/' });

      await controller.uploadAvatar(mockReq, file);

      expect(service.uploadAvatar).toHaveBeenCalledWith(
        'user-1',
        file,
        'https://api.tarmoto.app',
      );
    });

    it('500s in production when TARMOTO_PUBLIC_BASE_URL is unset', async () => {
      // Production behind a load balancer must NOT silently store
      // the request-derived host — the URL would point at the
      // internal pod hostname and 404 on every client. Fail loud.
      process.env.NODE_ENV = 'production';

      await expect(controller.uploadAvatar(mockReq, file)).rejects.toThrow(
        InternalServerErrorException,
      );
      expect(service.uploadAvatar).not.toHaveBeenCalled();
    });

    it('lets uploads through in production when TARMOTO_PUBLIC_BASE_URL is set', async () => {
      process.env.NODE_ENV = 'production';
      setEnv({ TARMOTO_PUBLIC_BASE_URL: 'https://api.tarmoto.app' });

      await controller.uploadAvatar(mockReq, file);

      expect(service.uploadAvatar).toHaveBeenCalledWith(
        'user-1',
        file,
        'https://api.tarmoto.app',
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
