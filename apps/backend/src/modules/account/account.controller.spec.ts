import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AccountController } from './account.controller.js';
import { AccountService } from './account.service.js';
import { AccountDeletionService } from './account-deletion.service.js';
import { IapValidateService } from './iap-validate.service.js';
import { AuthGuard } from '../auth/auth.guard.js';

const USER_ID = '11111111-1111-1111-1111-111111111111';

/**
 * Finding 3: the global `ValidationPipe` (see `main.ts`) rejects an invalid
 * `IapValidateRequestDto` BEFORE the handler runs, emitting Nest's default
 * `{ statusCode, message: string[], error }`. The route-scoped pipe on
 * `POST /account/subscription/iap/validate` must reshape those DTO-validation
 * 400s into the advertised `{ message: string, retryable: false }` contract so a
 * generated mobile client can apply the documented retry/finish decision.
 *
 * The suite mirrors the global pipe (whitelist / forbidNonWhitelisted /
 * transform) so the ONLY behavioural difference under test is the error SHAPE.
 * The auth guard is overridden to pass and seed `req.user`, so validation (which
 * runs after guards) is exercised in isolation.
 */
describe('AccountController — POST /account/subscription/iap/validate validation', () => {
  let app: INestApplication;
  const iapValidateService = { validate: jest.fn() };
  const snapshot = {
    provider: 'apple',
    tier: 'pro',
    status: 'active',
    retryable: false,
  };

  beforeEach(async () => {
    iapValidateService.validate.mockResolvedValue(snapshot);

    const moduleRef = await Test.createTestingModule({
      controllers: [AccountController],
      providers: [
        { provide: AccountService, useValue: {} },
        { provide: AccountDeletionService, useValue: {} },
        { provide: IapValidateService, useValue: iapValidateService },
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
    // Mirror the global pipe from main.ts so behaviour is identical; only the
    // route-scoped pipe's error shape differs.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    jest.clearAllMocks();
  });

  it('reshapes an unsupported provider (@IsIn) rejection to { message: string, retryable: false }', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/account/subscription/iap/validate')
      .send({ provider: 'google', transaction: 'signed-jws' })
      .expect(400);

    expect(typeof (res.body as { message: unknown }).message).toBe('string');
    expect(res.body).toMatchObject({ retryable: false });
    // NOT the default Nest validation body.
    expect(res.body).not.toHaveProperty('statusCode');
    expect(res.body).not.toHaveProperty('error');
    expect(iapValidateService.validate).not.toHaveBeenCalled();
  });

  it('reshapes a missing transaction to { message: string, retryable: false }', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/account/subscription/iap/validate')
      .send({ provider: 'apple' })
      .expect(400);

    expect(typeof (res.body as { message: unknown }).message).toBe('string');
    expect(res.body).toMatchObject({ retryable: false });
    expect(iapValidateService.validate).not.toHaveBeenCalled();
  });

  it('reshapes a forbidden non-whitelisted property to the same contract', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/account/subscription/iap/validate')
      .send({ provider: 'apple', transaction: 'signed-jws', bogus: 'x' })
      .expect(400);

    expect(typeof (res.body as { message: unknown }).message).toBe('string');
    expect(res.body).toMatchObject({ retryable: false });
    expect(iapValidateService.validate).not.toHaveBeenCalled();
  });

  it('passes a service-thrown terminal BadRequestException through UNCHANGED (already has retryable)', async () => {
    iapValidateService.validate.mockRejectedValue(
      new BadRequestException({
        message: 'This subscription is no longer active and cannot be applied.',
        retryable: false,
      }),
    );

    const res = await request(app.getHttpServer() as App)
      .post('/account/subscription/iap/validate')
      .send({ provider: 'apple', transaction: 'signed-jws' })
      .expect(400);

    expect(res.body).toEqual({
      message: 'This subscription is no longer active and cannot be applied.',
      retryable: false,
    });
    expect(iapValidateService.validate).toHaveBeenCalledTimes(1);
  });

  it('passes a valid body through to the service (pipe transforms, does not reject)', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/account/subscription/iap/validate')
      .send({ provider: 'apple', transaction: 'signed-jws' })
      .expect(201);

    expect(res.body).toMatchObject({ retryable: false });
    expect(iapValidateService.validate).toHaveBeenCalledWith(USER_ID, {
      provider: 'apple',
      transaction: 'signed-jws',
    });
  });
});
