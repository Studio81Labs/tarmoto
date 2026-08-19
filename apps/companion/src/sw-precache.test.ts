import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Regression guard, ported from tabletap's PWA: `/` redirects for signed-out
// visitors (middleware sends them to /login), and the Cache API rejects
// `cache.addAll`/`put` for redirected responses — so precaching the bare "/"
// route makes the whole install handler reject and the service worker never
// installs (losing the offline shell + installability). The SW must precache
// the real public entry `/explore` instead.
describe("service worker precache", () => {
  const sw = readFileSync(join(__dirname, "..", "public", "sw.js"), "utf8");

  // Pull the quoted entries straight out of the PRECACHE_URLS array so the
  // test tolerates prettier wrapping it across lines (with a trailing comma,
  // which JSON.parse would reject).
  function precacheUrls(): string[] {
    const group = sw.match(/const PRECACHE_URLS = (\[[\s\S]*?\]);/)?.[1];
    if (!group) throw new Error("PRECACHE_URLS not found in sw.js");
    return Array.from(group.matchAll(/"([^"]+)"/g)).map((m) => m[1]!);
  }

  it("precaches /explore, not the redirecting / route", () => {
    const urls = precacheUrls();
    expect(urls).toContain("/explore");
    expect(urls).not.toContain("/");
  });

  it("precaches /login so a lapsed session still lands somewhere offline", () => {
    expect(precacheUrls()).toContain("/login");
  });

  it("falls back to the cached requested route, then the /explore shell", () => {
    // The navigate handler serves the cached copy of the requested route (so a
    // precached /login survives offline) before the /explore shell.
    expect(sw).toContain("caches.match(req");
    expect(sw).toContain('caches.match("/explore")');
    expect(sw).not.toContain('caches.match("/")');
  });

  it("keeps the manifest and icon cache-first so the install surface works offline", () => {
    expect(precacheUrls()).toContain("/manifest.webmanifest");
    expect(precacheUrls()).toContain("/icon.svg");
  });
});
