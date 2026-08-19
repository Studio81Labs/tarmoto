/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DeviceToken } from '../../entities/device-token.entity.js';
import { DeviceTokensService } from './device-tokens.service.js';

const USER_ID = '11111111-1111-1111-1111-111111111111';

describe('DeviceTokensService', () => {
  let service: DeviceTokensService;
  let repo: jest.Mocked<
    Pick<Repository<DeviceToken>, 'findOne' | 'create' | 'save' | 'update'>
  >;

  beforeEach(async () => {
    repo = {
      findOne: jest.fn(),
      create: jest
        .fn()
        .mockImplementation((data: Partial<DeviceToken>) => ({ ...data })),
      save: jest.fn().mockImplementation((entity: DeviceToken) =>
        Promise.resolve({
          ...entity,
          id: 'd-1',
          created_at: new Date('2026-04-25T10:00:00Z'),
          updated_at: new Date('2026-04-25T10:00:00Z'),
        }),
      ),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeviceTokensService,
        { provide: getRepositoryToken(DeviceToken), useValue: repo },
      ],
    }).compile();

    service = module.get<DeviceTokensService>(DeviceTokensService);
  });

  describe('register', () => {
    it('creates a fresh row when no existing token matches', async () => {
      repo.findOne.mockResolvedValue(null);

      const result = await service.register(USER_ID, {
        platform: 'ios',
        token: 'tok-abc',
        app_version: '1.2.3',
      });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: USER_ID,
          platform: 'ios',
          token: 'tok-abc',
          app_version: '1.2.3',
        }),
      );
      expect(result.platform).toBe('ios');
      expect(result.device_id).toBe('d-1');
    });

    it('reactivates a soft-deleted row when the same token re-registers', async () => {
      const existing = {
        id: 'd-1',
        user_id: USER_ID,
        platform: 'ios',
        token: 'tok-abc',
        app_version: '1.0.0',
        created_at: new Date('2026-04-01T00:00:00Z'),
        updated_at: new Date('2026-04-01T00:00:00Z'),
        deleted_at: new Date('2026-04-10T00:00:00Z'),
      } as unknown as DeviceToken;
      repo.findOne.mockResolvedValue(existing);

      await service.register(USER_ID, {
        platform: 'ios',
        token: 'tok-abc',
        app_version: '1.2.3',
      });

      expect(existing.deleted_at).toBeNull();
      expect(existing.app_version).toBe('1.2.3');
      expect(repo.save).toHaveBeenCalledWith(existing);
      expect(repo.create).not.toHaveBeenCalled();
    });
  });

  describe('unregister', () => {
    it('soft-deletes the matching token', async () => {
      await service.unregister(USER_ID, 'tok-abc');
      expect(repo.update).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: USER_ID, token: 'tok-abc' }),
        expect.objectContaining({ deleted_at: expect.any(Date) }),
      );
    });
  });

  describe('unregisterAllForUser', () => {
    it('soft-deletes every active token for the user', async () => {
      repo.update.mockResolvedValueOnce({
        affected: 3,
        raw: [],
        generatedMaps: [],
      });
      const count = await service.unregisterAllForUser(USER_ID);
      expect(count).toBe(3);
      expect(repo.update).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: USER_ID }),
        expect.objectContaining({ deleted_at: expect.any(Date) }),
      );
    });
  });
});
