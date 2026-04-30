import { createHmac, timingSafeEqual } from 'node:crypto';

export type SignArgs = {
  requestId: string;
  expiresAt: number;
  secret: string;
};

export type VerifyArgs = SignArgs & { signature: string };

export type VerifyResult = 'valid' | 'invalid' | 'expired';

export function signDownloadUrl({
  requestId,
  expiresAt,
  secret,
}: SignArgs): string {
  const payload = `${requestId}:${expiresAt}`;
  return createHmac('sha256', secret).update(payload).digest('hex');
}

// Signatures are HMAC-SHA256 hex digests — exactly 64 lowercase hex
// characters. Reject anything else upfront so a malformed `?sig=`
// (especially non-ASCII or wrong-byte-length input) can't reach
// timingSafeEqual where a buffer-length mismatch would throw a
// RangeError and bubble out as a 500 instead of the intended 403.
const HEX_SIGNATURE = /^[0-9a-f]{64}$/;

export function verifyDownloadSignature({
  requestId,
  expiresAt,
  signature,
  secret,
}: VerifyArgs): VerifyResult {
  if (Date.now() > expiresAt) return 'expired';
  if (!HEX_SIGNATURE.test(signature)) return 'invalid';
  const expected = signDownloadUrl({ requestId, expiresAt, secret });
  // Both buffers are guaranteed equal-length (64 bytes) by the regex
  // above, so timingSafeEqual cannot throw.
  const ok = timingSafeEqual(
    Buffer.from(expected, 'utf8'),
    Buffer.from(signature, 'utf8'),
  );
  return ok ? 'valid' : 'invalid';
}
