import { Test, TestingModule } from '@nestjs/testing';
import { authGuardTestProviders } from '../auth/auth-test-providers.js';
import { BadgesController } from './badges.controller.js';
import { BadgesService } from './badges.service.js';

describe('BadgesController', () => {
  let controller: BadgesController;
  let service: jest.Mocked<BadgesService>;

  const mockReq = { user: { userId: 'user-1' } } as never;

  const mockBadge = {
    key: 'total_distance',
    name: 'Road Warrior',
    description: 'Total distance ridden',
    category: 'distance',
    tier: 'bronze',
    earned_at: '2026-04-10T10:00:00.000Z',
    progress: { current: 150, bronze: 100, silver: 1000, gold: 10000 },
  };

  beforeEach(async () => {
    const mockService = {
      listBadges: jest.fn().mockResolvedValue([mockBadge]),
      checkAndAward: jest
        .fn()
        .mockResolvedValue({ newly_earned: ['total_distance:silver'] }),
      computeProgression: jest.fn().mockResolvedValue({
        xp: 23750,
        level: 14,
        tier: 'Curve Hunter',
        next_tier: 'Mountain Goat',
        current_tier_xp: 11250,
        next_tier_xp: 26250,
        xp_to_next_tier: 2500,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BadgesController],
      providers: [
        { provide: BadgesService, useValue: mockService },
        ...authGuardTestProviders,
      ],
    }).compile();

    controller = module.get<BadgesController>(BadgesController);
    service = module.get(BadgesService);
  });

  it('GET /users/:userId/badges should list badges', async () => {
    const result = await controller.listBadges('user-1');

    expect(service.listBadges).toHaveBeenCalledWith('user-1');
    expect(result).toHaveLength(1);
    expect(result[0]!.tier).toBe('bronze');
  });

  it('POST /badges/check should check and award badges', async () => {
    const result = await controller.checkBadges(mockReq);

    expect(service.checkAndAward).toHaveBeenCalledWith('user-1');
    expect(result.newly_earned).toContain('total_distance:silver');
  });

  it("GET /users/me/progression returns the caller's progression", async () => {
    const result = await controller.getProgression(mockReq);

    expect(service.computeProgression).toHaveBeenCalledWith('user-1');
    expect(result.tier).toBe('Curve Hunter');
    expect(result.next_tier).toBe('Mountain Goat');
    expect(result.level).toBe(14);
  });
});
