import { Test, TestingModule } from '@nestjs/testing';
import { authGuardTestProviders } from '../auth/auth-test-providers.js';
import { ChallengesController } from './challenges.controller.js';
import { ChallengesService } from './challenges.service.js';

describe('ChallengesController', () => {
  let controller: ChallengesController;
  let service: jest.Mocked<ChallengesService>;

  const mockReq = { user: { userId: 'user-1' } } as never;

  const mockChallenge = {
    id: 'ch-1',
    content_key: 'roads_discovered',
    metric: 'roads_discovered',
    target: 10,
    starts_at: '2026-04-01T00:00:00.000Z',
    ends_at: '2026-04-30T23:59:59.000Z',
    reward_badge_key: 'spring_explorer',
    participant_count: 12,
  };

  beforeEach(async () => {
    const mockService = {
      listActive: jest.fn().mockResolvedValue([mockChallenge]),
      getDetail: jest.fn().mockResolvedValue({
        ...mockChallenge,
        my_progress: 5,
        my_completed: false,
        leaderboard: [],
      }),
      join: jest.fn().mockResolvedValue({
        challenge_id: 'ch-1',
        joined_at: '2026-04-15T10:00:00.000Z',
      }),
      getProgress: jest.fn().mockResolvedValue({
        challenge_id: 'ch-1',
        progress: 5,
        target: 10,
        completed: false,
        completed_at: null,
        percent: 50,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ChallengesController],
      providers: [
        { provide: ChallengesService, useValue: mockService },
        ...authGuardTestProviders,
      ],
    }).compile();

    controller = module.get<ChallengesController>(ChallengesController);
    service = module.get(ChallengesService);
  });

  it('GET /challenges should list active challenges', async () => {
    const result = await controller.listActive();

    expect(service.listActive).toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0]!.content_key).toBe('roads_discovered');
  });

  it('GET /challenges/:id should return detail with leaderboard', async () => {
    const result = await controller.getDetail(mockReq, 'ch-1');

    expect(service.getDetail).toHaveBeenCalledWith('ch-1', 'user-1');
    expect(result.my_progress).toBe(5);
  });

  it('POST /challenges/:id/join should join challenge', async () => {
    const result = await controller.join(mockReq, 'ch-1');

    expect(service.join).toHaveBeenCalledWith('user-1', 'ch-1');
    expect(result.challenge_id).toBe('ch-1');
  });

  it('GET /challenges/:id/progress should return progress', async () => {
    const result = await controller.getProgress(mockReq, 'ch-1');

    expect(service.getProgress).toHaveBeenCalledWith('user-1', 'ch-1');
    expect(result.percent).toBe(50);
  });
});
