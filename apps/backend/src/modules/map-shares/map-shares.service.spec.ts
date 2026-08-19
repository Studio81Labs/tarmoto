/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MapShare } from '../../entities/map-share.entity.js';
import { MapSharesService } from './map-shares.service.js';

describe('MapSharesService', () => {
  let service: MapSharesService;
  let repo: Partial<jest.Mocked<Repository<MapShare>>>;

  const mockShare = {
    id: 'share-1',
    owner_id: 'user-1',
    share_token: 'a'.repeat(32),
    title: 'My explored Czechia',
    snapshot: { ridden_segments: 1234, segments: [] },
    view_count: 3,
    created_at: new Date('2026-04-25T10:00:00Z'),
    updated_at: new Date('2026-04-25T10:00:00Z'),
    owner: { display_name: 'Jane Rider' },
  } as unknown as MapShare;

  beforeEach(async () => {
    // getByToken bumps view_count in-memory; reset across tests so each one
    // starts from the documented baseline.
    mockShare.view_count = 3;

    repo = {
      findOne: jest.fn().mockResolvedValue(mockShare),
      findAndCount: jest.fn().mockResolvedValue([[mockShare], 1]),
      create: jest
        .fn()
        .mockImplementation((data) => ({ ...mockShare, ...data })),
      save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
      increment: jest.fn().mockResolvedValue({ affected: 1 }),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MapSharesService,
        { provide: getRepositoryToken(MapShare), useValue: repo },
      ],
    }).compile();

    service = module.get<MapSharesService>(MapSharesService);
  });

  describe('create', () => {
    it('generates a 32-char hex share_token and persists the snapshot', async () => {
      const result = await service.create('user-1', {
        title: 'My explored Czechia',
        snapshot: { ridden_segments: 1234, segments: [] },
      });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          owner_id: 'user-1',
          title: 'My explored Czechia',
          snapshot: { ridden_segments: 1234, segments: [] },
        }),
      );
      const createMock = repo.create as jest.Mock;
      const createArgs = createMock.mock.calls[0]?.[0] as Partial<MapShare>;
      expect(createArgs?.share_token).toMatch(/^[0-9a-f]{32}$/);

      expect(repo.save).toHaveBeenCalled();
      expect(result.share_url).toBe(
        `/rides/road-map/shared/${result.share_token}`,
      );
      expect(result.title).toBe('My explored Czechia');
    });
  });

  describe('getByToken', () => {
    it('returns the snapshot and atomically increments view_count', async () => {
      const result = await service.getByToken('a'.repeat(32));

      expect(repo.findOne).toHaveBeenCalledWith({
        where: { share_token: 'a'.repeat(32) },
        relations: ['owner'],
      });
      expect(repo.increment).toHaveBeenCalledWith(
        { id: 'share-1' },
        'view_count',
        1,
      );
      expect(result.view_count).toBe(4);
      expect(result.owner_name).toBe('Jane Rider');
      expect(result.snapshot).toEqual({ ridden_segments: 1234, segments: [] });
    });

    it('throws 404 when the token does not resolve', async () => {
      (repo.findOne as jest.Mock).mockResolvedValueOnce(null);
      await expect(service.getByToken('missing')).rejects.toThrow(
        NotFoundException,
      );
      expect(repo.increment).not.toHaveBeenCalled();
    });

    it('falls back to "Unknown" when the owner relation is missing', async () => {
      (repo.findOne as jest.Mock).mockResolvedValueOnce({
        ...mockShare,
        owner: null,
      });
      const result = await service.getByToken('a'.repeat(32));
      expect(result.owner_name).toBe('Unknown');
    });

    it('hides shares whose owner has requested deletion (US-62 grace window)', async () => {
      (repo.findOne as jest.Mock).mockResolvedValueOnce({
        ...mockShare,
        owner: { ...mockShare.owner, deleted_at: new Date() },
      });

      await expect(service.getByToken('a'.repeat(32))).rejects.toThrow(
        NotFoundException,
      );
      expect(repo.increment).not.toHaveBeenCalled();
    });
  });

  describe('listMine', () => {
    it('returns only shares owned by the caller, newest first', async () => {
      const result = await service.listMine('user-1');

      expect(repo.findAndCount).toHaveBeenCalledWith({
        where: { owner_id: 'user-1' },
        order: { created_at: 'DESC' },
      });
      expect(result.total).toBe(1);
      expect(result.items[0]!.share_token).toBe('a'.repeat(32));
      expect(result.items[0]!.share_url).toBe(
        `/rides/road-map/shared/${'a'.repeat(32)}`,
      );
    });
  });

  describe('revoke', () => {
    it('removes the share when the caller is the owner', async () => {
      await service.revoke('user-1', 'share-1');

      expect(repo.remove).toHaveBeenCalledWith(mockShare);
    });

    it('throws 403 when the caller is not the owner', async () => {
      await expect(service.revoke('someone-else', 'share-1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(repo.remove).not.toHaveBeenCalled();
    });

    it('throws 404 when the share does not exist', async () => {
      (repo.findOne as jest.Mock).mockResolvedValueOnce(null);
      await expect(service.revoke('user-1', 'missing')).rejects.toThrow(
        NotFoundException,
      );
      expect(repo.remove).not.toHaveBeenCalled();
    });
  });
});
