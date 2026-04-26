import { sanitizeUserForExport } from './sanitizers.js';
import type { User } from '../../../../entities/user.entity.js';

describe('sanitizeUserForExport', () => {
  const baseUser = {
    id: 'u1',
    email: 'rider@example.com',
    password_hash: 'hash-secret',
    display_name: 'Rider',
    phone: '+15555550000',
    avatar_url: null,
    bio: null,
    home_region: 'NA',
    home_location: null,
    work_location: null,
    preferences: { theme: 'dark' },
    stripe_customer_id: 'cus_123',
    stripe_subscription_id: 'sub_123',
    subscription_tier: 'free',
    subscription_status: 'canceled',
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-02T00:00:00Z'),
  } as unknown as User;

  it('removes password_hash', () => {
    const out = sanitizeUserForExport(baseUser);
    expect(out).not.toHaveProperty('password_hash');
  });

  it('removes stripe identifiers', () => {
    const out = sanitizeUserForExport(baseUser);
    expect(out).not.toHaveProperty('stripe_customer_id');
    expect(out).not.toHaveProperty('stripe_subscription_id');
  });

  it('preserves profile fields', () => {
    const out = sanitizeUserForExport(baseUser);
    expect(out.email).toBe('rider@example.com');
    expect(out.display_name).toBe('Rider');
    expect(out.preferences).toEqual({ theme: 'dark' });
  });

  it('does not mutate the input', () => {
    const original = { ...baseUser };
    sanitizeUserForExport(baseUser);
    expect(baseUser).toEqual(original);
  });
});
