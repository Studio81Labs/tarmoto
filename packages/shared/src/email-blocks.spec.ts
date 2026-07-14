import { describe, it, expect } from "vitest";
import { isEmailBlockDocument } from "./email-blocks";

describe("isEmailBlockDocument", () => {
  it("accepts a valid document", () => {
    expect(
      isEmailBlockDocument({
        subject: "Hi {displayName}",
        blocks: [
          { type: "heading", text: "Your week" },
          { type: "paragraph", text: "You rode {rideSummary}." },
          { type: "button", label: "Explore", urlVar: "exploreUrl" },
          { type: "stat-row", label: "Distance", value: "{distance}" },
          { type: "divider" },
          { type: "spacer" },
        ],
      }),
    ).toBe(true);
  });

  it("rejects unknown block types and malformed blocks", () => {
    expect(
      isEmailBlockDocument({
        subject: "x",
        blocks: [{ type: "script", text: "x" }],
      }),
    ).toBe(false);
    expect(
      isEmailBlockDocument({
        subject: "x",
        blocks: [{ type: "button", label: "x" }],
      }),
    ).toBe(false);
    expect(isEmailBlockDocument({ subject: "x", blocks: "nope" })).toBe(false);
    expect(isEmailBlockDocument({ blocks: [] })).toBe(false);
    expect(isEmailBlockDocument(null)).toBe(false);
  });
});
