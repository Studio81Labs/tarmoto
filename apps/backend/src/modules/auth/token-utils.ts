import { createHash, randomBytes } from 'node:crypto';

/**
 * Verification + reset tokens use the same shape: 32 random bytes of
 * URL-safe entropy that we email as plaintext, paired with a SHA-256
 * digest that we persist. The plaintext never touches the database —
 * a leaked dump can't be replayed to verify accounts or hijack
 * password resets.
 *
 * 32 bytes is comfortably more than the 128 bits OWASP recommends
 * for one-time tokens; using more would only inflate URL length
 * without buying real security against any plausible attacker.
 */
const TOKEN_BYTES = 32;

export interface IssuedToken {
  /** The plaintext value to embed in the verification or reset URL. */
  raw: string;
  /** SHA-256 hex digest of `raw` — what we actually persist. */
  hash: string;
}

export const issueToken = (): IssuedToken => {
  const raw = randomBytes(TOKEN_BYTES).toString('base64url');
  const hash = hashToken(raw);
  return { raw, hash };
};

export const hashToken = (raw: string): string => {
  return createHash('sha256').update(raw).digest('hex');
};
