import { of } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import {
  AdminAuditService,
  AdminAuditInterceptor,
} from './admin-audit.interceptor.js';
import { setAdminAuditActor } from './admin-audit-context.js';

function repoMock() {
  return {
    create: jest.fn((v: unknown) => v),
    save: jest.fn().mockResolvedValue(undefined),
  };
}

function interceptorContextFor(
  method: string,
  url: string,
  adminUser?: Record<string, unknown>,
): { context: ExecutionContext; request: Record<string, unknown> } {
  const req: Record<string, unknown> = {
    method,
    url,
    originalUrl: url,
    headers: {},
    adminUser,
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { context, request: req };
}

function nextOf(value: unknown): CallHandler {
  return { handle: () => of(value) };
}

describe('AdminAuditService.record', () => {
  it('persists an audit row with the correct fields', async () => {
    const repo = repoMock();
    const service = new AdminAuditService(repo as never);
    await service.record({
      event_key: 'admin.metrics.read',
      outcome: 'allowed',
      method: 'GET',
      path: '/admin/metrics',
      admin_user_id: 'a1',
      admin_role: 'admin',
      metadata: null,
    });
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        event_key: 'admin.metrics.read',
        outcome: 'allowed',
      }),
    );
  });

  it('never throws when the insert fails', async () => {
    const repo = repoMock();
    repo.save = jest.fn().mockRejectedValue(new Error('db down'));
    const service = new AdminAuditService(repo as never);
    await expect(
      service.record({
        event_key: 'admin.auth.denied',
        outcome: 'denied',
        method: 'GET',
        path: '/admin/metrics',
        admin_user_id: null,
        admin_role: null,
        metadata: { reason: 'missing_session' },
      }),
    ).resolves.toBeUndefined();
  });
});

describe('AdminAuditInterceptor', () => {
  it('records an audit entry for a mutating (POST) request', async () => {
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const interceptor = new AdminAuditInterceptor(
      audit as unknown as AdminAuditService,
    );
    const { context } = interceptorContextFor('POST', '/admin/users', {
      id: 'a1',
      role: 'admin',
    });

    await new Promise<void>((resolve) => {
      interceptor
        .intercept(context, nextOf({ id: 'new-user' }))
        .subscribe({ complete: resolve });
    });

    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ event_key: 'admin.post', outcome: 'allowed' }),
    );
  });

  it('does not record an audit entry for a non-mutating (GET) request', async () => {
    const audit = { record: jest.fn() };
    const interceptor = new AdminAuditInterceptor(
      audit as unknown as AdminAuditService,
    );
    const { context } = interceptorContextFor('GET', '/admin/metrics');

    await new Promise<void>((resolve) => {
      interceptor
        .intercept(context, nextOf({ data: 'metrics' }))
        .subscribe({ complete: resolve });
    });

    expect(audit.record).not.toHaveBeenCalled();
  });

  it('uses the context actor when adminUser is not set (e.g. auth routes)', async () => {
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const interceptor = new AdminAuditInterceptor(
      audit as unknown as AdminAuditService,
    );
    // No adminUser — simulates a public-bypass auth route.
    const { context, request } = interceptorContextFor(
      'POST',
      '/admin/auth/login',
    );
    // Stamp the actor as the controller would after a successful login.
    setAdminAuditActor(request as unknown as Request, {
      admin_user_id: 'u42',
      admin_role: 'support',
    });

    await new Promise<void>((resolve) => {
      interceptor
        .intercept(context, nextOf({ accessToken: 'tok' }))
        .subscribe({ complete: resolve });
    });

    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        admin_user_id: 'u42',
        admin_role: 'support',
        outcome: 'allowed',
      }),
    );
  });
});
