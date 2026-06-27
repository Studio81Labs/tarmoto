import { hasRequiredAdminRole, canManageAdminRole } from './admin-role-rank.js';

describe('admin role rank', () => {
  it('allows a higher rank to satisfy a lower requirement', () => {
    expect(hasRequiredAdminRole('admin', ['support'])).toBe(true);
  });

  it('rejects a lower rank for a higher requirement', () => {
    expect(hasRequiredAdminRole('support', ['admin'])).toBe(false);
  });

  it('passes if any required role is satisfied', () => {
    expect(hasRequiredAdminRole('support', ['admin', 'support'])).toBe(true);
  });

  it('only lets an actor manage strictly lower roles', () => {
    expect(canManageAdminRole('super_admin', 'admin')).toBe(true);
    expect(canManageAdminRole('admin', 'admin')).toBe(false);
    expect(canManageAdminRole('admin', 'super_admin')).toBe(false);
  });
});
