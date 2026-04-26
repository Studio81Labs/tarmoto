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
});
