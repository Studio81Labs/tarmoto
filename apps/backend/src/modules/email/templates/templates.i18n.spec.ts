import type { SupportedLocale } from '@tarmoto/shared';
import { verificationTemplate, tripInviteTemplate } from './index.js';

/**
 * Locks security-relevant template behavior that the characterization
 * snapshots (templates.snapshot.spec.ts) don't cover, because those use
 * benign fixtures: (1) user data is HTML-escaped / text-raw even for
 * hostile input, and (2) an unregistered locale falls back to English.
 * `translateEmail`'s substitution is raw — escaping is the template's job,
 * via `escapeHtml`.
 */

const PREFS = 'https://app.tarmoto.example/settings/notifications';

describe('email i18n — escaping + fallback', () => {
  it('escapes user data in the HTML body, leaves the text body raw', () => {
    const out = verificationTemplate({
      preferencesUrl: PREFS,
      locale: 'en',
      displayName: '<script>alert(1)</script>',
      verifyUrl: 'https://x/y',
      expiresInHours: 24,
    });
    expect(out.html).not.toContain('<script>alert(1)</script>');
    expect(out.html).toContain('&lt;script&gt;');
    // Text part carries the raw name (no HTML context).
    expect(out.text).toContain('<script>alert(1)</script>');
  });

  it('escapes trip-invite user data (inviter name + message) in the HTML body, leaves the text body raw', () => {
    const out = tripInviteTemplate({
      preferencesUrl: PREFS,
      locale: 'en',
      inviterDisplayName: '<script>alert(1)</script>',
      tripTitle: 'Alps Loop',
      joinUrl: 'https://x/y',
      inviteCode: 'ABC123',
      message: '<script>evil</script>',
    });
    // Neither the inviter name (intro line) nor the message (quoted-message
    // blockquote) survives unescaped in the HTML body.
    expect(out.html).not.toContain('<script>alert(1)</script>');
    expect(out.html).not.toContain('<script>evil</script>');
    expect(out.html).toContain('&lt;script&gt;');
    // Text part carries the raw inviter name and message (no HTML context to escape for).
    expect(out.text).toContain('<script>alert(1)</script>');
    expect(out.text).toContain('<script>evil</script>');
  });

  it('renders English when the locale is not registered yet (en-only phase)', () => {
    const out = tripInviteTemplate({
      preferencesUrl: PREFS,
      locale: 'et' as SupportedLocale, // not registered — forces English fallback
      inviterDisplayName: 'Riku',
      tripTitle: 'Alps Loop',
      joinUrl: 'https://x/y',
      inviteCode: 'ABC123',
      message: null,
    });
    expect(out.subject).toContain('invited you to plan');
  });
});
