import { Test } from '@nestjs/testing';
import type { INestApplication, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AccountController } from './account.controller.js';
import { AccountService } from './account.service.js';
import { AccountDeletionService } from './account-deletion.service.js';
import { AuthGuard } from '../auth/auth.guard.js';

const USER_ID = '11111111-1111-1111-1111-111111111111';

/**
 * Spec 2026-08-06 §6 step 1: `POST /account/subscription/iap/validate` was
 * unmounted. It was authenticated and reachable in every environment with zero
 * callers — no mobile IAP SDK existed and nothing called it. Mobile IAP moves to
 * RevenueCat, whose purchases arrive by webhook.
 *
 * This suite's predecessor tested the route-scoped pipe that reshaped that
 * endpoint's DTO-validation 400s. With the route gone, the only thing worth
 * asserting is that it stays gone.
 */
describe('AccountController — retired IAP validate route', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AccountController],
      providers: [
        { provide: AccountService, useValue: {} },
        { provide: AccountDeletionService, useValue: {} },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest<Request>().user = { userId: USER_ID };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    jest.clearAllMocks();
  });

  it('404s on the retired iap/validate route', async () => {
    await request(app.getHttpServer() as App)
      .post('/account/subscription/iap/validate')
      .send({ provider: 'apple', transaction: 'signed-jws' })
      .expect(404);
  });
});
