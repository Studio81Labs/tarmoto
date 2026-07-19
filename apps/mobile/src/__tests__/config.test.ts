import { resolveApiBaseUrl } from "../config";

describe("resolveApiBaseUrl", () => {
  it("uses and normalizes an explicit URL", () => {
    expect(resolveApiBaseUrl(" https://example.test/// ", "ios", true)).toBe(
      "https://example.test",
    );
  });

  it("uses the Android emulator host alias in development", () => {
    expect(resolveApiBaseUrl(undefined, "android", true)).toBe(
      "http://10.0.2.2:3000",
    );
  });

  it("uses localhost for an iOS simulator in development", () => {
    expect(resolveApiBaseUrl(undefined, "ios", true)).toBe(
      "http://localhost:3000",
    );
  });

  it("uses the production API for release builds", () => {
    expect(resolveApiBaseUrl(undefined, "android", false)).toBe(
      "https://api.tarmoto.app",
    );
  });
});
