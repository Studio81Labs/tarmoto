import { AdminAuditService } from './admin-audit.interceptor.js';

function repoMock() {
  return {
    create: jest.fn((v: unknown) => v),
    save: jest.fn().mockResolvedValue(undefined),
  };
}

describe('AdminAuditService.record', () => {
  it('persists an audit row', async () => {
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
