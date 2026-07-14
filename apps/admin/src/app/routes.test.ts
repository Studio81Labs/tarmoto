import { describe, it, expect } from "vitest";
import { routes } from "./routes.js";

describe("routes", () => {
  it("includes the email-templates route for support+", () => {
    const r = routes.find((x) => x.key === "email-templates");
    expect(r).toBeDefined();
    expect(r?.minRole).toBe("support");
  });
});
