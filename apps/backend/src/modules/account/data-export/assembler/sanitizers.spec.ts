import { sanitizeUserForExport } from './sanitizers.js';
import type { User } from '../../../../entities/user.entity.js';

describe('sanitizeUserForExport', () => {
  const baseUser = {
    id: 'u1',
    email: 'rider@example.com',
    password_hash: 'hash-secret',
    purchase_account_token: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
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

  it('removes purchase_account_token — it is a credential, not profile data', () => {
    // Anyone holding this can call `Purchases.logIn` with it and bind purchases
    // to the rider's account, which is the attack the column exists to prevent.
    // The export archive is downloadable for seven days via a signed URL, so
    // shipping it in profile.json would hand out exactly that.
    const out = sanitizeUserForExport(baseUser);
    expect(out).not.toHaveProperty('purchase_account_token');
  });

  it('removes the subscription-lock coordination columns', () => {
    // These are `select: false`, so an ordinary load leaves them undefined and
    // this denylist looks redundant — which is exactly why it needs a test. The
    // sanitizer SPREADS the entity and deletes a denylist, so it is fail-open:
    // it protects the export only when a caller has explicitly selected the lock
    // columns (as guarded subscription writes do for the fence). Without populated
    // values in the fixture, deleting the whole `INTERNAL_USER_FIELDS` loop keeps
    // the suite green.
    //
    // Not secrets — every guard compares against the stored value server-side —
    // but internal plumbing, and `profile.json` is a document a person reads.
    const withLockState = {
      ...baseUser,
      subscription_lock_fence: 42,
      subscription_lock_owner: '11111111-2222-4333-8444-555555555555',
      subscription_lock_lease_expires_at: new Date('2026-01-03T00:00:00Z'),
    } as unknown as User;

    const out = sanitizeUserForExport(withLockState);

    expect(out).not.toHaveProperty('subscription_lock_fence');
    expect(out).not.toHaveProperty('subscription_lock_owner');
    expect(out).not.toHaveProperty('subscription_lock_lease_expires_at');
    // Ordinary profile data is untouched — the denylist is not over-broad.
    expect(out).toHaveProperty('display_name', 'Rider');
  });

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
  });

  it('strips preferences (it is served by preferences.json instead)', () => {
    const out = sanitizeUserForExport(baseUser);
    expect(out).not.toHaveProperty('preferences');
  });

  it('preserves subscription + billing fields the user is entitled to see', () => {
    const userWithBilling = {
      ...baseUser,
      subscription_tier: 'premium',
      subscription_status: 'active',
      subscription_cancel_at_period_end: true,
      subscription_current_period_end: new Date('2026-06-01T00:00:00Z'),
      billing_trial_used_at: new Date('2026-01-15T00:00:00Z'),
    } as unknown as User;
    const out = sanitizeUserForExport(userWithBilling) as unknown as Record<
      string,
      unknown
    >;
    expect(out.subscription_tier).toBe('premium');
    expect(out.subscription_status).toBe('active');
    expect(out.subscription_cancel_at_period_end).toBe(true);
    expect(out.subscription_current_period_end).toBeInstanceOf(Date);
    expect(out.billing_trial_used_at).toBeInstanceOf(Date);
  });

  it('does not mutate the input', () => {
    const original = { ...baseUser };
    sanitizeUserForExport(baseUser);
    expect(baseUser).toEqual(original);
  });
});
