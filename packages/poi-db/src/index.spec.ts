import { describe, it, expect } from "vitest";
import * as poiDb from "./index.js";

describe("@tarmoto/poi-db barrel", () => {
  it("is importable (shell in place; T2 populates it)", () => {
    expect(poiDb).toBeDefined();
  });
});
