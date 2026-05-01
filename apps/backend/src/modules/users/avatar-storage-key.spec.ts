import { avatarKeyFromUrl } from './avatar-storage-key.js';

describe('avatarKeyFromUrl', () => {
  describe('happy paths', () => {
    it('parses a server-relative LocalStorage URL', () => {
      expect(avatarKeyFromUrl('/uploads/avatars/user-1-123-uuid.png')).toBe(
        'avatars/user-1-123-uuid.png',
      );
    });

    it('parses a legacy absolute URL pointing at /uploads/avatars/<file>', () => {
      expect(
        avatarKeyFromUrl(
          'https://api.tarmoto.test/uploads/avatars/user-1-123-uuid.png',
        ),
      ).toBe('avatars/user-1-123-uuid.png');
    });

    it('parses an S3 / CDN URL where avatars/<file> is the path tail', () => {
      expect(
        avatarKeyFromUrl('https://cdn.example.com/avatars/user-1-123-uuid.png'),
      ).toBe('avatars/user-1-123-uuid.png');
    });

    it('decodes percent-encoded filenames', () => {
      expect(avatarKeyFromUrl('/uploads/avatars/user-1%2D123.png')).toBe(
        'avatars/user-1-123.png',
      );
    });
  });

  describe('rejects untrusted shapes (returns null)', () => {
    it('returns null for an empty / null URL', () => {
      expect(avatarKeyFromUrl(null)).toBeNull();
      expect(avatarKeyFromUrl('')).toBeNull();
    });

    it('returns null when the URL does not point at avatars/', () => {
      expect(
        avatarKeyFromUrl('https://cdn.example.com/photos/user-1.png'),
      ).toBeNull();
    });

    it('returns null for filenames with `..` traversal', () => {
      expect(
        avatarKeyFromUrl('/uploads/avatars/..%2F..%2Fsecrets.txt'),
      ).toBeNull();
    });

    it('returns null for filenames decoding to a dot segment', () => {
      expect(avatarKeyFromUrl('/uploads/avatars/%2e%2e')).toBeNull();
    });

    it('returns null for filenames containing control characters', () => {
      expect(avatarKeyFromUrl('/uploads/avatars/%00avatar.png')).toBeNull();
    });

    it('returns null for filenames with embedded slashes', () => {
      expect(avatarKeyFromUrl('/uploads/avatars/sub%2Fevil.png')).toBeNull();
    });

    it('returns null when the URL is malformed', () => {
      expect(avatarKeyFromUrl('not a valid url at all 🚫')).toBeNull();
    });

    it('does not false-positive on a path that merely contains "avatars" elsewhere', () => {
      // `/old-avatars-archive/foo.png` does not have `avatars/` as a
      // path segment, so it must NOT be treated as a managed avatar.
      expect(avatarKeyFromUrl('/old-avatars-archive/foo.png')).toBeNull();
    });
  });
});
