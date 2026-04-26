import type { User } from '../../../../entities/user.entity.js';

const STRIPPED_USER_FIELDS = [
  'password_hash',
  'stripe_customer_id',
  'stripe_subscription_id',
] as const;

export type SanitizedUser = Omit<
  User,
  (typeof STRIPPED_USER_FIELDS)[number] | 'contacts'
>;

export function sanitizeUserForExport(user: User): SanitizedUser {
  const clone: Record<string, unknown> = { ...user };
  for (const f of STRIPPED_USER_FIELDS) delete clone[f];
  delete clone.contacts;
  return clone as SanitizedUser;
}
