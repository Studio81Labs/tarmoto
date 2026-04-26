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

export function verifyDownloadSignature({
  requestId,
  expiresAt,
  signature,
  secret,
}: VerifyArgs): VerifyResult {
  if (Date.now() > expiresAt) return 'expired';
  const expected = signDownloadUrl({ requestId, expiresAt, secret });
  if (expected.length !== signature.length) return 'invalid';
  const ok = timingSafeEqual(
    Buffer.from(expected, 'utf8'),
    Buffer.from(signature, 'utf8'),
  );
  return ok ? 'valid' : 'invalid';
}
