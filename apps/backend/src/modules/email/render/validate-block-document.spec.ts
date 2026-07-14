import { validateBlockDocument } from './validate-block-document.js';

/**
 * Coverage for the write-path validation gate — run on draft-save, preview,
 * and publish (later tasks) before an admin-authored `EmailBlockDocument`
 * is accepted. Backs the same safety invariants `renderBlocks` enforces at
 * render time (see render-blocks.spec.ts), but as an author-facing 400
 * with field-level errors instead of a silent drop. See
 * docs/superpowers/specs/2026-07-14-admin-email-template-editor-phase2a-api-design.md
 */

const OK = {
  subject: 'Your week — {rideSummary}',
  blocks: [
    { type: 'paragraph', text: 'Hi {displayName}, you rode {distance}.' },
    { type: 'button', label: 'Explore', urlVar: 'exploreUrl' },
  ],
};

describe('validateBlockDocument (weekly-digest)', () => {
  it('accepts a doc whose vars are all whitelisted', () => {
    const r = validateBlockDocument('weekly-digest', OK);
    expect(r.ok).toBe(true);
  });

  it('rejects a CRLF subject', () => {
    const r = validateBlockDocument('weekly-digest', {
      ...OK,
      subject: 'a\r\nBcc: x',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('subject'))).toBe(true);
  });

  it('rejects an unknown {var}', () => {
    const r = validateBlockDocument('weekly-digest', {
      ...OK,
      blocks: [{ type: 'paragraph', text: '{ssn}' }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('ssn'))).toBe(true);
  });

  it('rejects a button urlVar not in the url whitelist', () => {
    const r = validateBlockDocument('weekly-digest', {
      ...OK,
      blocks: [{ type: 'button', label: 'x', urlVar: 'evil' }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('evil'))).toBe(true);
  });

  it('rejects a malformed block (isEmailBlockDocument)', () => {
    const r = validateBlockDocument('weekly-digest', {
      subject: 'x',
      blocks: [{ type: 'script' }],
    });
    expect(r.ok).toBe(false);
  });
});
