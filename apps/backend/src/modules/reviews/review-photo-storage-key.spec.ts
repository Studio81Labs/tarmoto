import {
  REVIEW_PHOTO_KEY_PREFIX,
  reviewPhotoFilenameFromKey,
  reviewPhotoKeyFromUrl,
} from './review-photo-storage-key.js';

describe('reviewPhotoKeyFromUrl', () => {
  // Trust everything from `app.tarmoto.test` (API origin) plus
  // `cdn.tarmoto.test` (CDN origin, mirrors the S3 deploy where the
  // bucket sits behind a custom domain). Third-party CDNs are NOT in
  // the trusted set so the resolver should reject them.
  const trustedOrigins = new Set([
    'https://app.tarmoto.test',
    'https://cdn.tarmoto.test',
  ]);
  const isTrustedOrigin = (parsed: URL): boolean =>
    trustedOrigins.has(parsed.origin);

  describe('happy paths', () => {
    it('parses a LocalStorage-shape URL (path includes /uploads/)', () => {
      expect(
        reviewPhotoKeyFromUrl(
          'https://app.tarmoto.test/uploads/road-review-photos/seg-1-user-1-shot.jpg',
          isTrustedOrigin,
        ),
      ).toBe(`${REVIEW_PHOTO_KEY_PREFIX}seg-1-user-1-shot.jpg`);
    });

    it('parses a S3 / CDN URL (path starts at /road-review-photos/)', () => {
      expect(
        reviewPhotoKeyFromUrl(
          'https://cdn.tarmoto.test/road-review-photos/seg-1-user-1-shot.jpg',
          isTrustedOrigin,
        ),
      ).toBe(`${REVIEW_PHOTO_KEY_PREFIX}seg-1-user-1-shot.jpg`);
    });

    it('decodes percent-encoded filenames', () => {
      expect(
        reviewPhotoKeyFromUrl(
          'https://app.tarmoto.test/uploads/road-review-photos/seg-1%2Duser-1.jpg',
          isTrustedOrigin,
        ),
      ).toBe(`${REVIEW_PHOTO_KEY_PREFIX}seg-1-user-1.jpg`);
    });
  });

  describe('rejects untrusted shapes (returns null)', () => {
    it('returns null for an empty / null URL', () => {
      expect(reviewPhotoKeyFromUrl(null, isTrustedOrigin)).toBeNull();
      expect(reviewPhotoKeyFromUrl('', isTrustedOrigin)).toBeNull();
      expect(reviewPhotoKeyFromUrl(undefined, isTrustedOrigin)).toBeNull();
    });

    it('returns null for a third-party CDN with a colliding path', () => {
      // `cdn.example.com` is not in the trusted set — even if the path
      // looks like ours, the URL is third-party and the cascade-delete
      // must NOT touch it (and the ownership check must NOT reject it).
      expect(
        reviewPhotoKeyFromUrl(
          'https://cdn.example.com/uploads/road-review-photos/seg-1-user-1-shot.jpg',
          isTrustedOrigin,
        ),
      ).toBeNull();
    });

    it('returns null for a URL that does not point at /road-review-photos/', () => {
      expect(
        reviewPhotoKeyFromUrl(
          'https://app.tarmoto.test/uploads/avatars/foo.jpg',
          isTrustedOrigin,
        ),
      ).toBeNull();
    });

    it('returns null for filenames with `..` traversal', () => {
      expect(
        reviewPhotoKeyFromUrl(
          'https://app.tarmoto.test/uploads/road-review-photos/..%2F..%2Fsecrets.txt',
          isTrustedOrigin,
        ),
      ).toBeNull();
    });

    it('returns null for filenames decoding to a dot segment', () => {
      expect(
        reviewPhotoKeyFromUrl(
          'https://app.tarmoto.test/uploads/road-review-photos/%2e%2e',
          isTrustedOrigin,
        ),
      ).toBeNull();
    });

    it('returns null for filenames containing control characters', () => {
      expect(
        reviewPhotoKeyFromUrl(
          'https://app.tarmoto.test/uploads/road-review-photos/%00pwn.jpg',
          isTrustedOrigin,
        ),
      ).toBeNull();
    });

    it('returns null for filenames with embedded slashes', () => {
      expect(
        reviewPhotoKeyFromUrl(
          'https://app.tarmoto.test/uploads/road-review-photos/sub%2Fevil.jpg',
          isTrustedOrigin,
        ),
      ).toBeNull();
    });

    it('returns null for relative URLs (no scheme)', () => {
      // We only emit absolute URLs from the upload endpoint; anything
      // without a scheme is legacy / third-party and not safe to
      // classify as managed.
      expect(
        reviewPhotoKeyFromUrl(
          '/uploads/road-review-photos/seg-1-user-1-x.jpg',
          isTrustedOrigin,
        ),
      ).toBeNull();
    });

    it('returns null for malformed URLs', () => {
      expect(
        reviewPhotoKeyFromUrl('not a valid url 🚫', isTrustedOrigin),
      ).toBeNull();
    });

    it('does not false-positive on a path that merely contains "road-review-photos" elsewhere', () => {
      // No `/road-review-photos/` separator in this URL — the substring
      // `road-review-photos` appears as part of a different segment, so
      // the resolver must NOT treat it as managed.
      expect(
        reviewPhotoKeyFromUrl(
          'https://app.tarmoto.test/old-road-review-photos-archive/foo.jpg',
          isTrustedOrigin,
        ),
      ).toBeNull();
    });
  });
});

describe('reviewPhotoFilenameFromKey', () => {
  it('strips the storage prefix', () => {
    expect(
      reviewPhotoFilenameFromKey(
        `${REVIEW_PHOTO_KEY_PREFIX}seg-1-user-1-shot.jpg`,
      ),
    ).toBe('seg-1-user-1-shot.jpg');
  });
});
