import type { User } from '../../../../entities/user.entity.js';

// Fields stripped because they're secrets we never expose under any
// circumstances.
const SECRET_USER_FIELDS = [
  'password_hash',
  'stripe_customer_id',
  'stripe_subscription_id',
  // Unguessability IS this token's security property: anyone holding it can
  // call `Purchases.logIn` with it and bind purchases to the rider's account.
  // Exporting it into `profile.json` — downloadable for seven days via a signed
  // URL — would hand out the very thing the column was introduced to protect.
  // Belt and braces with the entity's `select: false`.
  'purchase_account_token',
] as const;

// Fields stripped because they are INTERNAL COORDINATION STATE with no meaning
// to a rider: the per-rider subscription-mutation lock's fence token, lease
// holder and lease expiry. Not secrets — knowing them grants nothing, since every
// guard compares against the stored value server-side — but they are plumbing,
// and `profile.json` is a document a person reads.
//
// Note the shape of this module: it SPREADS the entity and deletes a denylist, so
// a new column is exported unless someone remembers to add it here. That is
// fail-open. `subscription_lock_fence` had already slipped through that way; it
// is stripped here with the two lease columns added alongside it, rather than
// leaving one exported and the others not.
const INTERNAL_USER_FIELDS = [
  'subscription_lock_fence',
  'subscription_lock_owner',
  'subscription_lock_lease_expires_at',
] as const;

// Fields stripped because they're served by other files in the bundle
// (preferences.json, contacts.json), so leaving them on profile.json
// would duplicate the data and risk one file diverging from the other
// if a future sanitizer is added to only one location.
const RELOCATED_USER_FIELDS = ['preferences', 'contacts'] as const;

export type SanitizedUser = Omit<
  User,
  | (typeof SECRET_USER_FIELDS)[number]
  | (typeof INTERNAL_USER_FIELDS)[number]
  | (typeof RELOCATED_USER_FIELDS)[number]
>;

export function sanitizeUserForExport(user: User): SanitizedUser {
  const clone: Record<string, unknown> = { ...user };
  for (const f of SECRET_USER_FIELDS) delete clone[f];
  for (const f of INTERNAL_USER_FIELDS) delete clone[f];
  for (const f of RELOCATED_USER_FIELDS) delete clone[f];
  return clone as SanitizedUser;
}
