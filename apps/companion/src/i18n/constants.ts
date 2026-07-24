export const LOCALE_COOKIE = "tarmoto-locale";
/**
 * Marks a locale chosen in this browser that has not yet been confirmed on
 * the authenticated user record. Keeping this separate from LOCALE_COOKIE is
 * important: the ordinary locale cookie may be older than a language change
 * made on mobile and must not, by itself, overwrite the account.
 */
export const LOCALE_SYNC_PENDING_COOKIE = "tarmoto-locale-sync-pending";
