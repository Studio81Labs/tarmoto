import { AdminContentController } from './admin-content.controller.js';
import { getAdminAuditTarget } from '../admin/admin-audit-context.js';
import { ContentType } from './content-types.js';

function makeService() {
  return {
    list: jest
      .fn()
      .mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 25 }),
    hide: jest.fn().mockResolvedValue({ id: 'h1' }),
    restore: jest.fn().mockResolvedValue({ id: 'h1' }),
    remove: jest.fn().mockResolvedValue(undefined),
  };
}

function makeReq() {
  return { adminUser: { id: 'admin-9', role: 'admin' } } as never;
}

describe('AdminContentController', () => {
  it('hide() delegates with the acting admin id and sets the audit target', async () => {
    const service = makeService();
    const ctrl = new AdminContentController(service as never);
    const req = makeReq();
    await ctrl.hide(req, ContentType.Hazard, 'h1', { reason: 'spam' });
    expect(service.hide).toHaveBeenCalledWith(
      ContentType.Hazard,
      'h1',
      'admin-9',
      'spam',
    );
    expect(getAdminAuditTarget(req)).toEqual({
      target_type: 'hazard_report',
      target_id: 'h1',
    });
  });

  it('restore() sets the audit target', async () => {
    const service = makeService();
    const ctrl = new AdminContentController(service as never);
    const req = makeReq();
    await ctrl.restore(req, ContentType.Review, 'r1');
    expect(service.restore).toHaveBeenCalledWith(ContentType.Review, 'r1');
    expect(getAdminAuditTarget(req)).toEqual({
      target_type: 'road_review',
      target_id: 'r1',
    });
  });

  it('remove() sets the audit target and delegates', async () => {
    const service = makeService();
    const ctrl = new AdminContentController(service as never);
    const req = makeReq();
    await ctrl.remove(req, ContentType.TripMessage, 'm1');
    expect(service.remove).toHaveBeenCalledWith(ContentType.TripMessage, 'm1');
    expect(getAdminAuditTarget(req)).toEqual({
      target_type: 'trip_message',
      target_id: 'm1',
    });
  });
});
