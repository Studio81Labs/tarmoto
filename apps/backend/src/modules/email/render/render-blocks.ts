/**
 * Code-owned block renderer — the safety boundary between admin-authored
 * `EmailBlock[]` documents (`@tarmoto/shared`) and the HTML/text Tarmoto
 * actually sends. Each block type compiles to fixed, code-owned markup;
 * there is deliberately no raw-HTML block. Every `{var}` token resolves
 * only from the template's whitelisted presentation vars (Task 3's
 * `{ textVars, urlVars }`) — unknown vars are dropped rather than echoed,
 * HTML contexts escape the resolved value, and a `button`'s `urlVar` must
 * be a key in `urlVars` or the button renders nothing at all. The existing
 * `renderLayout`/`renderTextFooter` chrome wraps the body, matching the
 * code-template rendering path. See
 * docs/superpowers/specs/2026-07-14-admin-email-template-editor-phase1-design.md
 */

import {
  renderLayout,
  renderTextFooter,
  escapeHtml,
} from '../templates/layout.js';
import type {
  EmailBlock,
  EmailBlockDocument,
  SupportedLocale,
} from '@tarmoto/shared';

interface Presentation {
  textVars: Record<string, string>;
  urlVars: Record<string, string>;
}
interface Opts {
  locale: SupportedLocale;
  preferencesUrl: string;
  marketingFooter: boolean;
}

const VAR = /\{(\w+)\}/g;
// Resolve {vars} from a map; unknown → "" (dropped). `escape` for HTML contexts.
// In HTML contexts the literal template text is escaped too — admin-authored
// `text`/`label`/`value` is free-form and must never reach the HTML raw, only
// the whitelisted {var} substitutions get special treatment. escapeHtml does
// not touch `{`/`}`/word chars, so `{var}` tokens survive the pre-escape.
function interp(
  text: string,
  vars: Record<string, string>,
  escape: boolean,
): string {
  const base = escape ? escapeHtml(text) : text;
  return base.replace(VAR, (_m, k: string) => {
    const v = Object.hasOwn(vars, k) ? vars[k] : undefined; // guard proto collision (constructor, etc.)
    if (v === undefined) return '';
    return escape ? escapeHtml(v) : v;
  });
}

function blockHtml(b: EmailBlock, p: Presentation): string {
  switch (b.type) {
    case 'heading':
      return `<p style="font-size:18px;font-weight:600;color:#f8fafc;margin:0 0 12px;">${interp(b.text, p.textVars, true)}</p>`;
    case 'paragraph':
      return `<p style="margin:0 0 16px;">${interp(b.text, p.textVars, true)}</p>`;
    case 'button': {
      // whitelist-only; unknown or reserved-name (e.g. "constructor") → no button
      const url = Object.hasOwn(p.urlVars, b.urlVar)
        ? p.urlVars[b.urlVar]
        : undefined;
      if (url === undefined) return '';
      return `<p style="margin:24px 0;"><a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 24px;background:#06b6d4;color:#0f172a;text-decoration:none;font-weight:600;border-radius:8px;">${interp(b.label, p.textVars, true)}</a></p>`;
    }
    case 'stat-row':
      return `<table role="presentation" width="100%" style="margin:6px 0;"><tr><td style="color:#94a3b8;font-size:14px;">${interp(b.label, p.textVars, true)}</td><td style="color:#f8fafc;font-size:16px;font-weight:600;text-align:right;">${interp(b.value, p.textVars, true)}</td></tr></table>`;
    case 'divider':
      return `<hr style="border:none;border-top:1px solid #334155;margin:24px 0;" />`;
    case 'spacer':
      return `<div style="height:16px;"></div>`;
  }
}

function blockText(b: EmailBlock, p: Presentation): string {
  switch (b.type) {
    case 'heading':
    case 'paragraph':
      return `${interp(b.text, p.textVars, false)}\n\n`;
    case 'button': {
      const url = Object.hasOwn(p.urlVars, b.urlVar)
        ? p.urlVars[b.urlVar]
        : undefined;
      return url === undefined
        ? ''
        : `${interp(b.label, p.textVars, false)}: ${url}\n\n`;
    }
    case 'stat-row':
      return `  • ${interp(b.label, p.textVars, false)}: ${interp(b.value, p.textVars, false)}\n`;
    case 'divider':
      return `—\n\n`;
    case 'spacer':
      return `\n`;
  }
}

export function renderBlocks(
  doc: EmailBlockDocument,
  p: Presentation,
  opts: Opts,
): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = interp(doc.subject, p.textVars, false); // subject is plain text → raw
  const bodyHtml = doc.blocks.map((b) => blockHtml(b, p)).join('\n');
  const html = renderLayout({
    preheader: subject,
    preferencesUrl: opts.preferencesUrl,
    marketingFooter: opts.marketingFooter,
    locale: opts.locale,
    bodyHtml,
  });
  const text = `${doc.blocks.map((b) => blockText(b, p)).join('')}${renderTextFooter(opts.preferencesUrl, opts.marketingFooter, opts.locale)}`;
  return { subject, html, text };
}
