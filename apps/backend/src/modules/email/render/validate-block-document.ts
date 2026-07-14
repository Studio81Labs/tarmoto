/**
 * Author-facing write-path validation gate — run on draft-save, preview,
 * and publish (later Phase 2a tasks) before an admin-authored block
 * document is persisted or rendered. Checks shape (Phase 1's
 * `isEmailBlockDocument`), subject safety (non-empty, no CRLF/control
 * chars — defensive against header injection if the mail provider ever
 * changes, reasonable max length), and the per-template variable
 * whitelist (`{var}` tokens in the subject/block text fields must be a
 * key of `TEMPLATE_WHITELIST[tag].textVars`; a `button.urlVar` must be a
 * key of `TEMPLATE_WHITELIST[tag].urlVars`). Returns field-level error
 * strings so the editor can point at the offending block/field, rather
 * than the single opaque failure `renderBlocks`' runtime drop gives.
 * `renderBlocks`' own whitelist enforcement remains the defense-in-depth
 * backstop; this is the author-facing gate. See
 * docs/superpowers/specs/2026-07-14-admin-email-template-editor-phase2a-api-design.md
 */

import {
  isEmailBlockDocument,
  type EmailBlock,
  type EmailBlockDocument,
} from '@tarmoto/shared';
import { TEMPLATE_WHITELIST, type EditableTag } from '../presentation/index.js';

const VAR = /\{(\w+)\}/g;
const SUBJECT_MAX = 255;

function varsIn(text: string): string[] {
  return [...text.matchAll(VAR)].map((m) => m[1]!);
}

/** Text fields an admin can put {vars} into, per block type. */
function textFieldsOf(b: EmailBlock): string[] {
  switch (b.type) {
    case 'heading':
    case 'paragraph':
      return [b.text];
    case 'stat-row':
      return [b.label, b.value];
    case 'button':
      return [b.label];
    default:
      return [];
  }
}

export function validateBlockDocument(
  tag: EditableTag,
  doc: unknown,
): { ok: true; doc: EmailBlockDocument } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isEmailBlockDocument(doc)) {
    return {
      ok: false,
      errors: [
        'Document shape is invalid (unknown block type or missing field).',
      ],
    };
  }
  const wl = TEMPLATE_WHITELIST[tag];
  const textVars = new Set(wl.textVars);
  const urlVars = new Set(wl.urlVars);

  const s = doc.subject;
  if (s.trim() === '') errors.push('subject: must not be empty.');
  // Intentional: detects CRLF/control chars defensively (header-injection
  // guard) — not a stray/mistaken pattern, so the control-char range is
  // deliberate here.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(s))
    errors.push('subject: must not contain line breaks or control characters.');
  if (s.length > SUBJECT_MAX)
    errors.push(`subject: must be ≤ ${SUBJECT_MAX} characters.`);
  for (const v of varsIn(s))
    if (!textVars.has(v)) errors.push(`subject: unknown variable {${v}}.`);

  doc.blocks.forEach((b, i) => {
    for (const field of textFieldsOf(b))
      for (const v of varsIn(field))
        if (!textVars.has(v))
          errors.push(`block ${i} (${b.type}): unknown variable {${v}}.`);
    if (b.type === 'button' && !urlVars.has(b.urlVar))
      errors.push(
        `block ${i} (button): urlVar "${b.urlVar}" is not a valid link for this template.`,
      );
  });

  return errors.length ? { ok: false, errors } : { ok: true, doc };
}
