/**
 * Structured email blocks authored by admins and rendered to safe, escaped
 * HTML by the backend's code-owned renderer. Deliberately NO raw-HTML block —
 * each block compiles to fixed markup, so an admin can never inject HTML. See
 * docs/superpowers/specs/2026-07-14-admin-email-template-editor-phase1-design.md
 */
export type EmailBlock =
  | { type: "heading"; text: string }
  | { type: "paragraph"; text: string }
  | { type: "button"; label: string; urlVar: string }
  | { type: "stat-row"; label: string; value: string }
  | { type: "divider" }
  | { type: "spacer" };

export const EMAIL_BLOCK_TYPES = [
  "heading",
  "paragraph",
  "button",
  "stat-row",
  "divider",
  "spacer",
] as const;

export interface EmailBlockDocument {
  /** Plain-text subject; whitelisted {vars} interpolated raw (not HTML). */
  subject: string;
  blocks: EmailBlock[];
}

function isBlock(v: unknown): v is EmailBlock {
  if (typeof v !== "object" || v === null) return false;
  const b = v as Record<string, unknown>;
  switch (b.type) {
    case "heading":
    case "paragraph":
      return typeof b.text === "string";
    case "button":
      return typeof b.label === "string" && typeof b.urlVar === "string";
    case "stat-row":
      return typeof b.label === "string" && typeof b.value === "string";
    case "divider":
    case "spacer":
      return true;
    default:
      return false;
  }
}

export function isEmailBlockDocument(v: unknown): v is EmailBlockDocument {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d.subject === "string" &&
    Array.isArray(d.blocks) &&
    d.blocks.every(isBlock)
  );
}
