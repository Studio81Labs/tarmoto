import {
  hashAdminPassword,
  verifyAdminPassword,
  hashRefreshToken,
  generateRefreshToken,
} from './admin-password.js';

describe('admin password + token helpers', () => {
  it('hashes and verifies a password', async () => {
    const hash = await hashAdminPassword('correct horse');
    expect(hash).not.toBe('correct horse');
    expect(await verifyAdminPassword('correct horse', hash)).toBe(true);
    expect(await verifyAdminPassword('wrong', hash)).toBe(false);
  });

  it('hashes refresh tokens deterministically', () => {
    expect(hashRefreshToken('abc')).toBe(hashRefreshToken('abc'));
    expect(hashRefreshToken('abc')).not.toBe(hashRefreshToken('def'));
  });

  it('generates distinct opaque refresh tokens', () => {
    expect(generateRefreshToken()).not.toBe(generateRefreshToken());
  });
});
