import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AuthGuard } from '../auth/auth.guard.js';
import { InAppNotificationsController } from './in-app-notifications.controller.js';
import { InAppNotificationsService } from './in-app-notifications.service.js';

describe('InAppNotificationsController', () => {
  let app: INestApplication;
  let service: jest.Mocked<Pick<InAppNotificationsService, 'markRead'>>;

  beforeEach(async () => {
    service = {
      markRead: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [InAppNotificationsController],
      providers: [{ provide: InAppNotificationsService, useValue: service }],
    })
      .overrideGuard(AuthGuard)
      .useValue({
        canActivate: (context: {
          switchToHttp: () => { getRequest: () => { user?: unknown } };
        }) => {
          context.switchToHttp().getRequest().user = { userId: 'user-1' };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('rejects malformed notification ids before querying the service', async () => {
    await request(app.getHttpServer() as App)
      .patch('/me/notifications/not-a-uuid/read')
      .expect(400);

    expect(service.markRead).not.toHaveBeenCalled();
  });
});
