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

// Fields stripped because they're served by other files in the bundle
// (preferences.json, contacts.json), so leaving them on profile.json
// would duplicate the data and risk one file diverging from the other
// if a future sanitizer is added to only one location.
const RELOCATED_USER_FIELDS = ['preferences', 'contacts'] as const;

export type SanitizedUser = Omit<
  User,
  (typeof SECRET_USER_FIELDS)[number] | (typeof RELOCATED_USER_FIELDS)[number]
>;

export function sanitizeUserForExport(user: User): SanitizedUser {
  const clone: Record<string, unknown> = { ...user };
  for (const f of SECRET_USER_FIELDS) delete clone[f];
  for (const f of RELOCATED_USER_FIELDS) delete clone[f];
  return clone as SanitizedUser;
}
