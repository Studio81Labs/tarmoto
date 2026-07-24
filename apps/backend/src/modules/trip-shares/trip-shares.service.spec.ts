/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { TripShare } from '../../entities/trip-share.entity.js';
import { TripMember } from '../../entities/trip-member.entity.js';
import { TripInvite } from '../../entities/trip-invite.entity.js';
import { User } from '../../entities/user.entity.js';
import { Trip } from '../../entities/trip.entity.js';
import { TripActivityService } from '../trip-activity/trip-activity.service.js';
import { FeatureResolver } from '../features/feature-resolver.service.js';
import { TripSharesService } from './trip-shares.service.js';

describe('TripSharesService', () => {
  let service: TripSharesService;
  let repo: Partial<jest.Mocked<Repository<TripShare>>>;
  let tripRepo: Partial<jest.Mocked<Repository<Trip>>>;
  let memberRepo: Partial<jest.Mocked<Repository<TripMember>>>;
  let inviteRepo: Partial<jest.Mocked<Repository<TripInvite>>>;
  let userRepo: Partial<jest.Mocked<Repository<User>>>;
  let activity: jest.Mocked<Pick<TripActivityService, 'recordSafe'>>;
  let featureResolver: jest.Mocked<
    Pick<FeatureResolver, 'resolveLimitsForUser'>
  >;
  // The join path serialises its cap-check + insert inside
  // `dataSource.transaction`, taking a per-trip advisory lock. The mock runs
  // the callback with a manager whose `getRepository` returns the same repo
  // mocks the assertions already target, and records the `pg_advisory_xact_lock`
  // call so a test can prove the lock is taken.
  let managerQuery: jest.Mock;
  let dataSource: { transaction: jest.Mock };

  const mockShare = {
    id: 'share-1',
    owner_id: 'user-1',
    share_token: 'a'.repeat(32),
    title: 'Pyrenees Loop',
    snapshot: { days: [] },
    view_count: 3,
    created_at: new Date('2026-04-20T10:00:00Z'),
    updated_at: new Date('2026-04-20T10:00:00Z'),
    owner: { display_name: 'Jane Rider' },
  } as unknown as TripShare;

  beforeEach(async () => {
    // Reset the mutable view counter — getByToken bumps it in-memory and we
    // reuse the same reference across tests.
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
    tripRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: 'trip-1',
        invite_code: 'ABCDEFGH',
      }),
    };
    inviteRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    userRepo = {
      findOne: jest.fn().mockResolvedValue(null),
    };
    memberRepo = {
      findOne: jest.fn().mockResolvedValue({
        trip_id: 'trip-1',
        user_id: 'user-1',
        role: 'owner',
      }),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockImplementation((data) => data as TripMember),
      save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
    };
    activity = {
      recordSafe: jest.fn().mockResolvedValue(undefined),
    };
    // Unlimited by default so every pre-existing join test short-circuits the
    // collaborator-cap check; only the cap tests override it.
    featureResolver = {
      resolveLimitsForUser: jest.fn().mockResolvedValue({
        max_active_trips: null,
        max_trip_collaborators: null,
      }),
    };

    managerQuery = jest.fn().mockResolvedValue(undefined);
    const manager = {
      query: managerQuery,
      getRepository: jest.fn((entity) => {
        if (entity === TripMember) return memberRepo;
        if (entity === TripInvite) return inviteRepo;
        return undefined;
      }),
    };
    dataSource = {
      transaction: jest.fn((cb: (m: typeof manager) => unknown) => cb(manager)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TripSharesService,
        { provide: getRepositoryToken(TripShare), useValue: repo },
        { provide: getRepositoryToken(Trip), useValue: tripRepo },
        { provide: getRepositoryToken(TripMember), useValue: memberRepo },
        { provide: getRepositoryToken(TripInvite), useValue: inviteRepo },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: TripActivityService, useValue: activity },
        { provide: FeatureResolver, useValue: featureResolver },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get<TripSharesService>(TripSharesService);
  });

  describe('create', () => {
    it('generates a 32-char hex share_token and persists the snapshot', async () => {
      const result = await service.create('user-1', {
        title: 'Pyrenees Loop',
        snapshot: { days: [] },
      });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          owner_id: 'user-1',
          title: 'Pyrenees Loop',
          snapshot: { days: [] },
        }),
      );
      const createMock = repo.create as jest.Mock;
      const createArgs = createMock.mock.calls[0]?.[0] as Partial<TripShare>;
      expect(createArgs?.share_token).toMatch(/^[0-9a-f]{32}$/);

      expect(repo.save).toHaveBeenCalled();
      expect(result.share_url).toBe(`/trips/shared/${result.share_token}`);
      expect(result.title).toBe('Pyrenees Loop');
    });

    it('attaches a server trip id to the share when the caller can invite collaborators', async () => {
      const result = await service.create('user-1', {
        title: 'Pyrenees Loop',
        snapshot: { days: [] },
        trip_id: 'trip-1',
      });

      expect(memberRepo.findOne).toHaveBeenCalledWith({
        where: { trip_id: 'trip-1', user_id: 'user-1' },
      });
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          trip_id: 'trip-1',
        }),
      );
      expect(result.trip_id).toBe('trip-1');
    });
  });

  describe('joinByToken', () => {
    it('adds the caller as a member of the trip attached to the share token', async () => {
      (repo.findOne as jest.Mock).mockResolvedValueOnce({
        ...mockShare,
        trip_id: 'trip-1',
      });
      (memberRepo.findOne as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      const result = await service.joinByToken('user-2', 'a'.repeat(32));

      expect(memberRepo.save).toHaveBeenCalledWith({
        trip_id: 'trip-1',
        user_id: 'user-2',
        role: 'viewer',
      });
      expect(activity.recordSafe).toHaveBeenCalledWith(
        'trip-1',
        'user-2',
        'member_joined',
        { source: 'trip_share', role: 'viewer' },
      );
      expect(
        JSON.stringify(activity.recordSafe.mock.calls[0]?.[3]),
      ).not.toContain('a'.repeat(32));
      expect(result).toEqual({
        trip_id: 'trip-1',
        planner_url: '/trips/planner?tripId=trip-1',
      });
    });

    it('returns the planner URL without duplicating membership for an existing member', async () => {
      (repo.findOne as jest.Mock).mockResolvedValueOnce({
        ...mockShare,
        trip_id: 'trip-1',
      });
      (memberRepo.findOne as jest.Mock).mockResolvedValueOnce({
        trip_id: 'trip-1',
        user_id: 'user-2',
        role: 'viewer',
      });

      const result = await service.joinByToken('user-2', 'a'.repeat(32));

      expect(memberRepo.save).not.toHaveBeenCalled();
      expect(activity.recordSafe).not.toHaveBeenCalled();
      expect(result.planner_url).toBe('/trips/planner?tripId=trip-1');
    });

    it('serialises the cap check + insert under a per-trip advisory lock', async () => {
      (repo.findOne as jest.Mock).mockResolvedValueOnce({
        ...mockShare,
        trip_id: 'trip-1',
      });
      (memberRepo.findOne as jest.Mock).mockResolvedValueOnce(null);

      await service.joinByToken('user-2', 'a'.repeat(32));

      // The insert ran inside dataSource.transaction, and the first thing that
      // transaction did was take the per-trip advisory lock — so concurrent
      // joins on the same link can't both pass the cap and overflow it.
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(managerQuery).toHaveBeenCalledWith(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        ['trip_shares:collaborators:trip-1'],
      );
      expect(memberRepo.save).toHaveBeenCalled();
    });

    it('403s (feature-limit) when an anonymous link-joiner would exceed the owner cap', async () => {
      featureResolver.resolveLimitsForUser.mockResolvedValue({
        max_active_trips: null,
        max_trip_collaborators: 1,
      });
      (repo.findOne as jest.Mock).mockResolvedValueOnce({
        ...mockShare,
        trip_id: 'trip-1',
      });
      (tripRepo.findOne as jest.Mock).mockResolvedValueOnce({
        id: 'trip-1',
        owner_id: 'owner-1',
      });
      (memberRepo.findOne as jest.Mock).mockResolvedValueOnce(null); // not yet a member
      // No account + no pending invite → an anonymous NEW collaborator.
      (userRepo.findOne as jest.Mock).mockResolvedValueOnce(null);
      (inviteRepo.findOne as jest.Mock).mockResolvedValueOnce(null);
      (memberRepo.count as jest.Mock).mockResolvedValue(1); // one non-owner member already
      (inviteRepo.count as jest.Mock).mockResolvedValue(0);

      await expect(
        service.joinByToken('user-2', 'a'.repeat(32)),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Cap is the OWNER's, enforced before the member is inserted.
      expect(featureResolver.resolveLimitsForUser).toHaveBeenCalledWith(
        'owner-1',
      );
      expect(memberRepo.save).not.toHaveBeenCalled();
    });

    it('allows a joiner consuming their pending invite even at the cap (net-zero)', async () => {
      featureResolver.resolveLimitsForUser.mockResolvedValue({
        max_active_trips: null,
        max_trip_collaborators: 1,
      });
      (repo.findOne as jest.Mock).mockResolvedValueOnce({
        ...mockShare,
        trip_id: 'trip-1',
      });
      (tripRepo.findOne as jest.Mock).mockResolvedValueOnce({
        id: 'trip-1',
        owner_id: 'owner-1',
      });
      (memberRepo.findOne as jest.Mock).mockResolvedValueOnce(null);
      // The joiner has a pending invite (already counted) → cap check skipped.
      (userRepo.findOne as jest.Mock).mockResolvedValueOnce({
        id: 'user-2',
        email: 'joiner@example.com',
      });
      (inviteRepo.findOne as jest.Mock).mockResolvedValueOnce({
        id: 'inv-1',
        role: 'editor',
      });

      await expect(
        service.joinByToken('user-2', 'a'.repeat(32)),
      ).resolves.toBeDefined();
      expect(memberRepo.save).toHaveBeenCalled();
      expect(memberRepo.count).not.toHaveBeenCalled(); // invite consumed → no cap count
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
      // Bumped in-memory so the response reflects the post-increment value
      // without a re-select.
      expect(result.view_count).toBe(4);
      expect(result.owner_name).toBe('Jane Rider');
      expect(result.snapshot).toEqual({ days: [] });
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

    it('hides trip shares whose owner has requested deletion (US-62 grace window)', async () => {
      (repo.findOne as jest.Mock).mockResolvedValueOnce({
        ...mockShare,
        owner: { ...mockShare.owner, deleted_at: new Date() },
      });

      // 404 — same response as an unknown token, so a share-link
      // visitor can't side-channel whether the owner deleted their
      // account or the link was always invalid.
      await expect(service.getByToken('a'.repeat(32))).rejects.toThrow(
        NotFoundException,
      );
      // The view-count side-effect must not fire for hidden shares.
      expect(repo.increment).not.toHaveBeenCalled();
    });
  });

  describe('findActiveByToken', () => {
    // Internal shared lookup behind `getByToken` and the token join flow.
    // Same 404 surface, but no view_count side-effect — internal reads
    // shouldn't inflate the public traffic counter.

    it('returns the raw share row without bumping view_count', async () => {
      const result = await service.findActiveByToken('a'.repeat(32));

      expect(repo.findOne).toHaveBeenCalledWith({
        where: { share_token: 'a'.repeat(32) },
        relations: ['owner'],
      });
      expect(repo.increment).not.toHaveBeenCalled();
      // Returns the entity (not the public DTO) — callers materialise
      // the snapshot directly.
      expect(result.id).toBe('share-1');
      expect(result.snapshot).toEqual({ days: [] });
      // Counter stays at the pre-call value.
      expect(result.view_count).toBe(3);
    });

    it('throws 404 when the token does not resolve', async () => {
      (repo.findOne as jest.Mock).mockResolvedValueOnce(null);
      await expect(service.findActiveByToken('missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('hides shares owned by a soft-deleted account (US-62 grace window)', async () => {
      // Mirrors getByToken so the import path can't side-channel an
      // account-deletion via a different response code.
      (repo.findOne as jest.Mock).mockResolvedValueOnce({
        ...mockShare,
        owner: { ...mockShare.owner, deleted_at: new Date() },
      });
      await expect(service.findActiveByToken('a'.repeat(32))).rejects.toThrow(
        NotFoundException,
      );
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
      expect(result.items[0].share_token).toBe('a'.repeat(32));
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
