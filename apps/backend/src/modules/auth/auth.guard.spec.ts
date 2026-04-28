import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Repository } from 'typeorm';
import type { Request } from 'express';
import { AuthGuard } from './auth.guard.js';
import { OptionalAuthGuard } from './optional-auth.guard.js';
import { User } from '../../entities/user.entity.js';

function makeContext(authHeader?: string): ExecutionContext {
  const req = {
    headers: authHeader ? { authorization: authHeader } : {},
  } as unknown as Request;
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe('AuthGuard (US-62 soft-delete check)', () => {
  let guard: AuthGuard;
  let jwt: jest.Mocked<JwtService>;
  let userRepo: jest.Mocked<Pick<Repository<User>, 'findOne'>>;

  beforeEach(async () => {
    jwt = {
      verifyAsync: jest
        .fn()
        .mockResolvedValue({ sub: 'user-1', type: 'access' }),
    } as unknown as jest.Mocked<JwtService>;
    userRepo = {
      findOne: jest.fn().mockResolvedValue({ id: 'user-1', deleted_at: null }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthGuard,
        { provide: JwtService, useValue: jwt },
        { provide: getRepositoryToken(User), useValue: userRepo },
      ],
    }).compile();
    guard = module.get(AuthGuard);
  });

  it('allows requests from a non-deleted user', async () => {
    const ctx = makeContext('Bearer good-token');
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(userRepo.findOne).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: { id: true, deleted_at: true },
    });
  });

  it('rejects requests when the account has been soft-deleted, even with a valid JWT', async () => {
    // Regression for US-62: previously the guard only verified the JWT
    // signature, so a rider's existing access token (1h TTL) kept
    // working for up to an hour after they hit DELETE /account.
    userRepo.findOne.mockResolvedValueOnce({
      id: 'user-1',
      deleted_at: new Date('2026-04-25T12:00:00Z'),
    } as User);
    const ctx = makeContext('Bearer good-token');
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects requests when the user row is gone (post-purge token replay)', async () => {
    userRepo.findOne.mockResolvedValueOnce(null);
    const ctx = makeContext('Bearer good-token');
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects when the JWT is missing', async () => {
    await expect(guard.canActivate(makeContext())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(userRepo.findOne).not.toHaveBeenCalled();
  });

  it('rejects when the token type is refresh (not access)', async () => {
    jwt.verifyAsync.mockResolvedValueOnce({
      sub: 'user-1',
      type: 'refresh',
    } as never);
    await expect(
      guard.canActivate(makeContext('Bearer refresh-token')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(userRepo.findOne).not.toHaveBeenCalled();
  });
});

describe('OptionalAuthGuard (US-62 soft-delete check)', () => {
  let guard: OptionalAuthGuard;
  let jwt: jest.Mocked<JwtService>;
  let userRepo: jest.Mocked<Pick<Repository<User>, 'findOne'>>;

  beforeEach(async () => {
    jwt = {
      verifyAsync: jest
        .fn()
        .mockResolvedValue({ sub: 'user-1', type: 'access' }),
    } as unknown as jest.Mocked<JwtService>;
    userRepo = {
      findOne: jest.fn().mockResolvedValue({ id: 'user-1', deleted_at: null }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OptionalAuthGuard,
        { provide: JwtService, useValue: jwt },
        { provide: getRepositoryToken(User), useValue: userRepo },
      ],
    }).compile();
    guard = module.get(OptionalAuthGuard);
  });

  it('lets the request through unauthenticated when no token is present', async () => {
    const ctx = makeContext();
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(userRepo.findOne).not.toHaveBeenCalled();
  });

  it('treats a soft-deleted account as anonymous (does not block the request)', async () => {
    userRepo.findOne.mockResolvedValueOnce({
      id: 'user-1',
      deleted_at: new Date(),
    } as User);
    const req = {
      headers: { authorization: 'Bearer good-token' },
    } as unknown as Request;
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req).not.toHaveProperty('user');
  });

  it('attaches req.user when the token is valid and the account is active', async () => {
    const req = {
      headers: { authorization: 'Bearer good-token' },
    } as unknown as Request;
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;

    await guard.canActivate(ctx);
    expect((req as Request & { user?: { userId: string } }).user).toEqual({
      userId: 'user-1',
    });
  });
});
