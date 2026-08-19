import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildContentSecurityPolicy,
  connectSources,
  createNonce,
} from "./security-headers";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("connectSources", () => {
  it("carries the API origin, its websocket twin, and both map origins", () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api-staging.tarmoto.app");
    const sources = connectSources();
    expect(sources).toContain("'self'");
    expect(sources).toContain("https://api-staging.tarmoto.app");
    expect(sources).toContain("wss://api-staging.tarmoto.app");
    expect(sources).toContain("https://tiles.openfreemap.org");
    expect(sources).toContain("https://ags.cuzk.gov.cz");
  });

  it("reduces URLs to origins — a path in the env var must not leak into the policy", () => {
    vi.stubEnv(
      "NEXT_PUBLIC_MAP_STYLE_URL",
      "https://styles.example.com/custom/liberty.json",
    );
    expect(connectSources()).toContain("https://styles.example.com");
    expect(connectSources().some((s) => s.includes("/custom"))).toBe(false);
  });

  it("tolerates the aerial tile template's {z}/{y}/{x} placeholders", () => {
    // The default itself carries them; the origin must still resolve.
    expect(connectSources()).toContain("https://ags.cuzk.gov.cz");
  });

  it("falls back to the loopback API origin when the env var is garbage", () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "not a url");
    const sources = connectSources();
    expect(sources).toContain("http://localhost:3000");
    expect(sources).toContain("ws://localhost:3000");
  });
});

describe("buildContentSecurityPolicy", () => {
  it("binds the script policy to the request nonce with strict-dynamic", () => {
    const csp = buildContentSecurityPolicy("abc123");
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
  });

  it("keeps MapLibre alive: blob workers, blob/data images, tile origins in connect-src", () => {
    const csp = buildContentSecurityPolicy("n");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("img-src 'self' blob: data:");
    expect(csp).toContain("https://tiles.openfreemap.org");
  });

  it("refuses framing — the embed widgets were retired with the dark theme", () => {
    expect(buildContentSecurityPolicy("n")).toContain("frame-ancestors 'none'");
  });

  it("allows the service worker's own scope through manifest-src and self", () => {
    const csp = buildContentSecurityPolicy("n");
    expect(csp).toContain("manifest-src 'self'");
  });
});

describe("createNonce", () => {
  it("emits unique base64 nonces", () => {
    const a = createNonce();
    const b = createNonce();
    expect(a).not.toBe(b);
    expect(() => atob(a)).not.toThrow();
    expect(atob(a)).toHaveLength(16);
  });
});
