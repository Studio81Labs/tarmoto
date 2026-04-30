import { signDownloadUrl, verifyDownloadSignature } from './signed-url.js';

describe('signed-url', () => {
  const secret = 'test-secret-please-change';

  it('verifies a freshly signed token', () => {
    const expiresAt = Date.now() + 60_000;
    const sig = signDownloadUrl({
      requestId: 'req-1',
      expiresAt,
      secret,
    });
    expect(
      verifyDownloadSignature({
        requestId: 'req-1',
        expiresAt,
        signature: sig,
        secret,
      }),
    ).toBe('valid');
  });

  it('rejects a tampered request id', () => {
    const expiresAt = Date.now() + 60_000;
    const sig = signDownloadUrl({
      requestId: 'req-1',
      expiresAt,
      secret,
    });
    expect(
      verifyDownloadSignature({
        requestId: 'req-2',
        expiresAt,
        signature: sig,
        secret,
      }),
    ).toBe('invalid');
  });

  it('rejects an expired token', () => {
    const expiresAt = Date.now() - 1;
    const sig = signDownloadUrl({
      requestId: 'req-1',
      expiresAt,
      secret,
    });
    expect(
      verifyDownloadSignature({
        requestId: 'req-1',
        expiresAt,
        signature: sig,
        secret,
      }),
    ).toBe('expired');
  });

  it('rejects a wrong secret', () => {
    const expiresAt = Date.now() + 60_000;
    const sig = signDownloadUrl({
      requestId: 'req-1',
      expiresAt,
      secret,
    });
    expect(
      verifyDownloadSignature({
        requestId: 'req-1',
        expiresAt,
        signature: sig,
        secret: 'wrong',
      }),
    ).toBe('invalid');
  });

  it('rejects a different-length signature', () => {
    const expiresAt = Date.now() + 60_000;
    expect(
      verifyDownloadSignature({
        requestId: 'req-1',
        expiresAt,
        signature: 'shorty',
        secret,
      }),
    ).toBe('invalid');
  });

  it('rejects a non-hex signature without throwing', () => {
    const expiresAt = Date.now() + 60_000;
    // Same character length as a real hex digest (64), but contains
    // non-ASCII chars — timingSafeEqual would throw on the resulting
    // unequal buffer lengths if we let it through.
    const nonAscii = '★'.repeat(64);
    expect(
      verifyDownloadSignature({
        requestId: 'req-1',
        expiresAt,
        signature: nonAscii,
        secret,
      }),
    ).toBe('invalid');
  });

  it('rejects uppercase hex (signatures are emitted lowercase)', () => {
    const expiresAt = Date.now() + 60_000;
    const sig = signDownloadUrl({
      requestId: 'req-1',
      expiresAt,
      secret,
    }).toUpperCase();
    expect(
      verifyDownloadSignature({
        requestId: 'req-1',
        expiresAt,
        signature: sig,
        secret,
      }),
    ).toBe('invalid');
  });
});
