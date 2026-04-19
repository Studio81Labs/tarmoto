/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { ChallengesService } from './challenges.service.js';
import { Challenge } from '../../entities/challenge.entity.js';
import { ChallengeEntry } from '../../entities/challenge-entry.entity.js';

describe('ChallengesService', () => {
  let service: ChallengesService;
  let challengeRepo: Partial<jest.Mocked<Repository<Challenge>>>;
  let entryRepo: Partial<jest.Mocked<Repository<ChallengeEntry>>>;

  const now = new Date();
  const mockChallenge = {
    id: 'ch-1',
    title: 'Spring Explorer',
    description: 'Ride 10 new roads this month',
    metric: 'roads_discovered',
    target: 10,
    starts_at: new Date(now.getTime() - 86400000),
    ends_at: new Date(now.getTime() + 86400000 * 30),
    reward_badge_key: 'spring_explorer',
    is_active: true,
  } as unknown as Challenge;

  const mockEntry = {
    id: 'entry-1',
    challenge_id: 'ch-1',
    user_id: 'user-1',
    progress: 5,
    completed: false,
    completed_at: null,
    joined_at: new Date(),
    challenge: mockChallenge,
    user: { display_name: 'John Rider' },
  } as unknown as ChallengeEntry;

  beforeEach(async () => {
    challengeRepo = {
      find: jest.fn().mockResolvedValue([mockChallenge]),
      findOne: jest.fn().mockResolvedValue(mockChallenge),
    };
    entryRepo = {
      find: jest.fn().mockResolvedValue([mockEntry]),
      findOne: jest.fn().mockResolvedValue(mockEntry),
      count: jest.fn().mockResolvedValue(5),
      create: jest.fn().mockImplementation((data) => ({ ...data })),
      save: jest.fn().mockImplementation((entity) =>
        Promise.resolve({
          ...entity,
          id: entity.id ?? 'entry-new',
          joined_at: entity.joined_at ?? new Date(),
        }),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChallengesService,
        { provide: getRepositoryToken(Challenge), useValue: challengeRepo },
        {
          provide: getRepositoryToken(ChallengeEntry),
          useValue: entryRepo,
        },
      ],
    }).compile();

    service = module.get<ChallengesService>(ChallengesService);
    jest.clearAllMocks();
  });

  describe('listActive', () => {
    it('should return active challenges with participant counts', async () => {
      challengeRepo.find!.mockResolvedValueOnce([mockChallenge]);
      entryRepo.count!.mockResolvedValueOnce(12);

      const result = await service.listActive();

      expect(result).toHaveLength(1);
      expect(result[0].title).toBe('Spring Explorer');
      expect(result[0].participant_count).toBe(12);
    });

    it('should return empty array when no active challenges', async () => {
      challengeRepo.find!.mockResolvedValueOnce([]);

      const result = await service.listActive();

      expect(result).toHaveLength(0);
    });
  });

  describe('getDetail', () => {
    it('should return challenge with leaderboard and user progress', async () => {
      entryRepo.count!.mockResolvedValueOnce(5);
      entryRepo.find!.mockResolvedValueOnce([mockEntry]);
      entryRepo.findOne!.mockResolvedValueOnce(mockEntry);

      const result = await service.getDetail('ch-1', 'user-1');

      expect(result.title).toBe('Spring Explorer');
      expect(result.my_progress).toBe(5);
      expect(result.my_completed).toBe(false);
      expect(result.leaderboard).toHaveLength(1);
      expect(result.leaderboard[0].rank).toBe(1);
    });

    it('should return null progress when user not provided', async () => {
      entryRepo.count!.mockResolvedValueOnce(5);
      entryRepo.find!.mockResolvedValueOnce([]);

      const result = await service.getDetail('ch-1');

      expect(result.my_progress).toBeNull();
      expect(result.my_completed).toBeNull();
    });

    it('should throw NotFoundException for missing challenge', async () => {
      challengeRepo.findOne!.mockResolvedValueOnce(null);

      await expect(service.getDetail('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('join', () => {
    it('should join an active challenge', async () => {
      const result = await service.join('user-1', 'ch-1');

      expect(entryRepo.create).toHaveBeenCalledWith({
        challenge_id: 'ch-1',
        user_id: 'user-1',
      });
      expect(result.challenge_id).toBe('ch-1');
      expect(result.joined_at).toBeDefined();
    });

    it('should throw NotFoundException for missing challenge', async () => {
      challengeRepo.findOne!.mockResolvedValueOnce(null);

      await expect(service.join('user-1', 'missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException for deactivated challenge', async () => {
      challengeRepo.findOne!.mockResolvedValueOnce(null);

      await expect(service.join('user-1', 'ch-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException for expired challenge', async () => {
      challengeRepo.findOne!.mockResolvedValueOnce({
        ...mockChallenge,
        ends_at: new Date(now.getTime() - 86400000),
      } as unknown as Challenge);

      await expect(service.join('user-1', 'ch-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException for future challenge', async () => {
      challengeRepo.findOne!.mockResolvedValueOnce({
        ...mockChallenge,
        starts_at: new Date(now.getTime() + 86400000 * 10),
      } as unknown as Challenge);

      await expect(service.join('user-1', 'ch-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw ConflictException on duplicate join', async () => {
      entryRepo.save!.mockRejectedValueOnce({ code: '23505' });

      await expect(service.join('user-1', 'ch-1')).rejects.toThrow(
        ConflictException,
      );
    });

    it('should rethrow non-unique-constraint errors', async () => {
      entryRepo.save!.mockRejectedValueOnce(new Error('connection lost'));

      await expect(service.join('user-1', 'ch-1')).rejects.toThrow(
        'connection lost',
      );
    });
  });

  describe('getProgress', () => {
    it('should return progress with percentage', async () => {
      const result = await service.getProgress('user-1', 'ch-1');

      expect(result.progress).toBe(5);
      expect(result.target).toBe(10);
      expect(result.percent).toBe(50);
      expect(result.completed).toBe(false);
    });

    it('should cap percent at 100', async () => {
      entryRepo.findOne!.mockResolvedValueOnce({
        ...mockEntry,
        progress: 15,
        completed: true,
        completed_at: new Date(),
      } as unknown as ChallengeEntry);

      const result = await service.getProgress('user-1', 'ch-1');

      expect(result.percent).toBe(100);
      expect(result.completed).toBe(true);
    });

    it('should return 0 percent when target is zero', async () => {
      const zeroTargetChallenge = { ...mockChallenge, target: 0 };
      entryRepo.findOne!.mockResolvedValueOnce({
        ...mockEntry,
        progress: 0,
        challenge: zeroTargetChallenge,
      } as unknown as ChallengeEntry);

      const result = await service.getProgress('user-1', 'ch-1');

      expect(result.percent).toBe(0);
      expect(result.target).toBe(0);
    });

    it('should throw NotFoundException when not participating', async () => {
      entryRepo.findOne!.mockResolvedValueOnce(null);

      await expect(service.getProgress('user-1', 'ch-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updateProgress', () => {
    it('should update progress and mark completed when target reached', async () => {
      await service.updateProgress('user-1', 'ch-1', 10);

      expect(entryRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          progress: 10,
          completed: true,
          completed_at: expect.any(Date),
        }),
      );
    });

    it('should not mark completed when below target', async () => {
      entryRepo.findOne!.mockResolvedValueOnce({
        ...mockEntry,
        progress: 3,
        completed: false,
        completed_at: null,
      } as unknown as ChallengeEntry);

      await service.updateProgress('user-1', 'ch-1', 7);

      expect(entryRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          progress: 7,
          completed: false,
        }),
      );
    });

    it('should not re-complete already completed entry', async () => {
      entryRepo.findOne!.mockResolvedValueOnce({
        ...mockEntry,
        completed: true,
        completed_at: new Date('2026-04-10T10:00:00Z'),
      } as unknown as ChallengeEntry);

      await service.updateProgress('user-1', 'ch-1', 12);

      expect(entryRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          completed_at: new Date('2026-04-10T10:00:00Z'),
        }),
      );
    });

    it('should silently return when entry not found', async () => {
      entryRepo.findOne!.mockResolvedValueOnce(null);

      await service.updateProgress('user-1', 'ch-1', 5);

      expect(entryRepo.save).not.toHaveBeenCalled();
    });
  });
});
