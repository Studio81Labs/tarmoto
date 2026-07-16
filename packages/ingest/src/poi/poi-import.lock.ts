/**
 * Deterministic 32-bit key from `source:code` so e.g. `(osm, CZ)` and
 * `(fsq, CZ)` never collide under the shared advisory-lock namespace
 * (`LOCK_NAMESPACE` in `poi-import.service.ts`). Extracted as a pure function
 * (#847 review) so the hash's collision behavior can be unit-tested directly,
 * independent of the DataSource/QueryRunner plumbing in `importRegion`.
 */
export function poiAdvisoryLockKey(source: string, code: string): number {
  const s = `${source}:${code}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}
