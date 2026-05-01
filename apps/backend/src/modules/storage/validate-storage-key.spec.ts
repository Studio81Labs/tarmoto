import { validateStorageKey } from './validate-storage-key.js';

describe('validateStorageKey', () => {
  it('accepts a simple relative key', () => {
    expect(() => validateStorageKey('avatars/user-1.png')).not.toThrow();
  });

  it('accepts deeper paths', () => {
    expect(() => validateStorageKey('reviews/2026/05/photo.jpg')).not.toThrow();
  });

  it('rejects an empty key', () => {
    expect(() => validateStorageKey('')).toThrow(/invalid storage key/i);
  });

  it('rejects keys with `..` segments', () => {
    expect(() => validateStorageKey('avatars/../../etc/passwd')).toThrow(
      /invalid storage key/i,
    );
  });

  it('rejects keys with `.` segments', () => {
    expect(() => validateStorageKey('avatars/./foo.png')).toThrow(
      /invalid storage key/i,
    );
  });

  it('rejects absolute keys', () => {
    expect(() => validateStorageKey('/etc/passwd')).toThrow(
      /invalid storage key/i,
    );
  });

  it('rejects keys containing backslashes', () => {
    expect(() => validateStorageKey('avatars\\foo.png')).toThrow(
      /invalid storage key/i,
    );
  });

  it('rejects keys with embedded control characters', () => {
    expect(() => validateStorageKey('avatars/foo\x00bar.png')).toThrow(
      /invalid storage key/i,
    );
  });

  it('rejects keys with embedded DEL (U+007F)', () => {
    expect(() => validateStorageKey('avatars/foo\x7fbar.png')).toThrow(
      /invalid storage key/i,
    );
  });

  it('rejects keys with consecutive slashes', () => {
    expect(() => validateStorageKey('avatars//foo.png')).toThrow(
      /invalid storage key/i,
    );
  });
});
