import { renderBlocks } from './render-blocks.js';

/**
 * Coverage for the code-owned block renderer — the safety boundary between
 * admin-authored `EmailBlock[]` documents and the HTML/text actually sent.
 * Every case here backs one of the safety invariants: HTML vars AND literal
 * block text/label/value are escaped (admin-authored markup never reaches
 * the wire raw), the subject is interpolated raw (plain-text header),
 * unknown `{var}` tokens are dropped rather than echoed (including
 * `Object.prototype` names like `constructor`), and a `button` whose
 * `urlVar` isn't in the whitelisted `urlVars` renders no button `<a>` (the
 * layout's own unrelated preferences-link `<a>` in the footer chrome is
 * always present and is not part of this guarantee). See
 * docs/superpowers/specs/2026-07-14-admin-email-template-editor-phase1-design.md
 */

const PRES = {
  textVars: { displayName: '<b>Riku</b>', rideSummary: '4 rides' },
  urlVars: { exploreUrl: 'https://x/explore' },
};
const OPTS = {
  locale: 'en' as const,
  preferencesUrl: 'https://x/prefs',
  marketingFooter: true,
};

describe('renderBlocks', () => {
  it('resolves + escapes vars, drops unknowns, wraps in chrome', () => {
    const out = renderBlocks(
      {
        subject: 'Hi {displayName} — {unknown}',
        blocks: [
          { type: 'paragraph', text: 'You rode {rideSummary}, {displayName}.' },
          { type: 'button', label: 'Explore', urlVar: 'exploreUrl' },
        ],
      },
      PRES,
      OPTS,
    );
    // subject: raw interpolation (plain-text header), unknown dropped
    expect(out.subject).toBe('Hi <b>Riku</b> — ');
    // html: user var escaped, unknown dropped, button url present, chrome present
    expect(out.html).toContain('You rode 4 rides, &lt;b&gt;Riku&lt;/b&gt;.');
    expect(out.html).toContain('href="https://x/explore"');
    expect(out.html).toContain('<!doctype html>');
    // text: raw var, plain projection
    expect(out.text).toContain('You rode 4 rides, <b>Riku</b>.');
  });

  it('ignores a button whose urlVar is not in urlVars', () => {
    const out = renderBlocks(
      {
        subject: 'x',
        blocks: [{ type: 'button', label: 'X', urlVar: 'evilUrl' }],
      },
      PRES,
      OPTS,
    );
    expect(out.html).not.toContain('evilUrl');
    expect(out.html).not.toContain('href="evil');
    // no CTA-styled anchor at all — only the layout's own preferences link
    // (which is unrelated chrome, always present) may render an <a>
    expect(out.html).not.toMatch(/<a\b[^>]*background:#06b6d4/);
  });

  it('escapes literal admin-authored markup, not just {var} substitutions', () => {
    const out = renderBlocks(
      {
        subject: 'x',
        blocks: [
          { type: 'heading', text: 'Hi <script>alert(1)</script>' },
          {
            type: 'paragraph',
            text: 'Click <a href="https://phish">x</a>',
          },
          { type: 'button', label: 'Go <b>now</b>', urlVar: 'exploreUrl' },
        ],
      },
      PRES,
      OPTS,
    );
    // heading: raw <script> in the block's own text must be escaped
    expect(out.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out.html).not.toContain('<script>alert(1)</script>');
    // paragraph: a literal anchor authored in `text` must not become a live <a>
    expect(out.html).not.toMatch(/<a href="https:\/\/phish"/);
    expect(out.html).toContain('&lt;a href=&quot;https://phish&quot;&gt;');
    // button label: literal markup in `label` must be escaped too
    expect(out.html).toContain('Go &lt;b&gt;now&lt;/b&gt;');
  });

  it('guards {var} and urlVar lookups against Object.prototype collisions', () => {
    const out = renderBlocks(
      {
        subject: 'x',
        blocks: [
          { type: 'paragraph', text: '{constructor}' },
          { type: 'button', label: 'X', urlVar: 'constructor' },
        ],
      },
      PRES,
      OPTS,
    );
    // {constructor} is not an own key of textVars → dropped, not the Object ctor
    expect(out.html).toContain('<p style="margin:0 0 16px;"></p>');
    // urlVar "constructor" is not an own key of urlVars → no button, no throw
    // (only the layout's own unrelated preferences-link <a> may be present)
    expect(out.html).not.toMatch(/<a\b[^>]*background:#06b6d4/);
  });
});
