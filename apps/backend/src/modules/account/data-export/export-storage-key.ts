/**
 * GDPR data-export bundles live under the `exports/` prefix in the
 * shared object-storage bucket. The runbook documents this prefix as
 * the carve-out the per-bucket lifecycle rule auto-expires after 30
 * days, so production housekeeping only fires on user-deletable
 * personal data — avatars and review photos under their own prefixes
 * are retained for the lifetime of the user / review.
 *
 * Keys are server-generated as `exports/<userId>/<requestId>.zip`;
 * both segments are UUIDs (or UUID-shaped) so they pass the shared
 * `validateStorageKey` guard without further sanitisation.
 */
export const EXPORT_KEY_PREFIX = 'exports/';

export function exportStorageKey(userId: string, requestId: string): string {
  return `${EXPORT_KEY_PREFIX}${userId}/${requestId}.zip`;
}
