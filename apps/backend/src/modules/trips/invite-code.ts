import { randomBytes } from 'node:crypto';

// Crockford-ish uppercase alphabet (no ambiguous I/L/O/0/1/U). `TripsService.join`
// normalises submitted codes with `.toUpperCase()`, so every generated code MUST
// be uppercase or the join lookup will miss it.
const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const INVITE_LENGTH = 8;

/**
 * Generate a uniformly-distributed uppercase trip invite code. Shared by trip
 * creation/duplication and community-route cloning so every code is in the same
 * case-insensitive space the join path expects.
 */
export function generateInviteCode(): string {
  // randomBytes for entropy; reject the small biased tail at the top of each
  // byte so every code character is uniformly drawn from the 30-char alphabet
  // (240 = floor(256 / 30) * 30).
  const out: string[] = [];
  while (out.length < INVITE_LENGTH) {
    const buf = randomBytes(INVITE_LENGTH);
    for (const byte of buf) {
      if (byte >= 240) continue;
      out.push(INVITE_ALPHABET[byte % INVITE_ALPHABET.length]);
      if (out.length === INVITE_LENGTH) break;
    }
  }
  return out.join('');
}
