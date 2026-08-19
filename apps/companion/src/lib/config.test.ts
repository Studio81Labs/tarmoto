import { describe, expect, it } from "vitest";
import { envOrDefault } from "./config";

describe("envOrDefault", () => {
  it("keeps a real value", () => {
    expect(envOrDefault("https://styles.example.com/x.json", "fallback")).toBe(
      "https://styles.example.com/x.json",
    );
  });

  it("falls back on undefined", () => {
    expect(envOrDefault(undefined, "fallback")).toBe("fallback");
  });

  it("falls back on the empty string the Dockerfile materializes for unset optional args", () => {
    // ENV NEXT_PUBLIC_…=$TARMOTO_… turns an unset build arg into "", which
    // `??` would wave through — an empty MAP_STYLE_URL built a styleless
    // maplibre Map and crashed every map page (#1255).
    expect(envOrDefault("", "fallback")).toBe("fallback");
  });

  it("falls back on whitespace-only values", () => {
    expect(envOrDefault("   ", "fallback")).toBe("fallback");
  });

  it("trims a padded value", () => {
    expect(envOrDefault("  https://a.example  ", "fallback")).toBe(
      "https://a.example",
    );
  });
});
