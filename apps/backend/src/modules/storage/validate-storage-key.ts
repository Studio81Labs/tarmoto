import { hasControlCharacters } from '../../common/control-characters.js';

/**
 * Path-traversal guard applied by every `ObjectStorage` provider
 * before it touches its backend. Keys must be:
 *
 *   - non-empty
 *   - free of backslashes (Windows separator) and ASCII control chars
 *     (which would let a stored URL smuggle a null byte through
 *     `decodeURIComponent` and escape the managed prefix)
 *   - relative — no leading `/` (prevents an absolute filesystem
 *     path / S3 key from masquerading as a relative one)
 *   - made of well-formed slash-delimited segments — empty, `.`, and
 *     `..` segments are all rejected
 *
 * Centralised so a hardening fix can't drift between the local-FS
 * and S3 providers. Throws a plain `Error` so callers (which run
 * inside Nest's exception filter) surface a 500 — these inputs are
 * always server-generated, never user-controlled, so an invalid key
 * is a programming error, not a 4xx.
 */
export function validateStorageKey(key: string): void {
  if (!key || key.length === 0) {
    throw new Error('invalid storage key: empty');
  }
  if (key.includes('\\')) {
    throw new Error(`invalid storage key: ${key}`);
  }
  if (hasControlCharacters(key)) {
    throw new Error(`invalid storage key: ${key}`);
  }
  if (key.startsWith('/')) {
    throw new Error(`invalid storage key: ${key}`);
  }
  for (const segment of key.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error(`invalid storage key: ${key}`);
    }
  }
}
