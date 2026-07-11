import { translateEmail } from './index.js';

describe('translateEmail', () => {
  it('returns catalog copy and interpolates values', () => {
    expect(translateEmail('common.greeting.named', { name: 'Riku' })).toBe(
      'Hi Riku,',
    );
    expect(translateEmail('verification.subject')).toBe(
      'Verify your Tarmoto email',
    );
  });

  it('falls back to English for an unpopulated locale (the deliberate en-only seam)', () => {
    // @ts-expect-error — 'et' is not registered yet; exercises fallback
    expect(translateEmail('verification.subject', undefined, 'et')).toBe(
      'Verify your Tarmoto email',
    );
  });
});
