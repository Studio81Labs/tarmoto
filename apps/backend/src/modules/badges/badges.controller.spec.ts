/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
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
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BadgesController],
      providers: [
        { provide: BadgesService, useValue: mockService },
        { provide: JwtService, useValue: { verifyAsync: jest.fn() } },
      ],
    }).compile();

    controller = module.get<BadgesController>(BadgesController);
    service = module.get(BadgesService);
  });

  it('GET /users/:userId/badges should list badges', async () => {
    const result = await controller.listBadges('user-1');

    expect(service.listBadges).toHaveBeenCalledWith('user-1');
    expect(result).toHaveLength(1);
    expect(result[0].tier).toBe('bronze');
  });

  it('POST /badges/check should check and award badges', async () => {
    const result = await controller.checkBadges(mockReq);

    expect(service.checkAndAward).toHaveBeenCalledWith('user-1');
    expect(result.newly_earned).toContain('total_distance:silver');
  });
});
