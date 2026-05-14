import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { IsNull, type Repository } from 'typeorm';
import { UserNotification } from '../../entities/user-notification.entity.js';
import { InAppNotificationsService } from './in-app-notifications.service.js';

describe('InAppNotificationsService', () => {
  let service: InAppNotificationsService;
  let repo: jest.Mocked<Pick<Repository<UserNotification>, 'count' | 'find'>>;

  beforeEach(async () => {
    repo = {
      count: jest.fn().mockResolvedValue(0),
      find: jest.fn().mockResolvedValue([]),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        InAppNotificationsService,
        {
          provide: getRepositoryToken(UserNotification),
          useValue: repo,
        },
      ],
    }).compile();

    service = moduleRef.get(InAppNotificationsService);
  });

  it('falls back to the default limit when the requested limit is not finite', async () => {
    await service.list('user-1', Number.NaN);

    expect(repo.find).toHaveBeenCalledWith({
      where: { user_id: 'user-1' },
      order: { created_at: 'DESC' },
      take: 20,
    });
    expect(repo.count).toHaveBeenCalledWith({
      where: { user_id: 'user-1', read_at: IsNull() },
    });
  });
});
