// Content-Security-Policy for every companion page, shaped after tabletap's
// PWA middleware. Lives outside middleware.ts so the policy is unit-testable
// — a CSP typo doesn't fail loudly, it silently blocks the map or the
// service worker, which is the expensive place to find out.

const DEFAULT_API_URL = "http://localhost:3000";
const DEFAULT_MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const DEFAULT_AERIAL_TILES_URL =
  "https://ags.cuzk.gov.cz/arcgis1/rest/services/ORTOFOTO_WM/MapServer/tile/{z}/{y}/{x}";

function safeOrigin(raw: string | undefined, fallback: string): string {
  const candidate = raw ?? fallback;
  try {
    // Tile templates carry {z}/{y}/{x} placeholders; URL() tolerates them in
    // the path, and only the origin is used here.
    return new URL(candidate).origin;
  } catch {
    return new URL(fallback).origin;
  }
}

export function connectSources(): string[] {
  const apiOrigin = safeOrigin(
    process.env.NEXT_PUBLIC_API_URL,
    DEFAULT_API_URL,
  );
  // MapLibre fetches the style, vector tiles, sprites, and glyphs itself —
  // all connect-src, not img-src (raster tiles included: the GL backend
  // loads them via fetch). OpenFreeMap serves style + tiles + sprites +
  // glyphs from one origin; the aerial layer is a separate XYZ service.
  const styleOrigin = safeOrigin(
    process.env.NEXT_PUBLIC_MAP_STYLE_URL,
    DEFAULT_MAP_STYLE_URL,
  );
  const aerialOrigin = safeOrigin(
    process.env.NEXT_PUBLIC_AERIAL_TILES_URL,
    DEFAULT_AERIAL_TILES_URL,
  );
  const wsOrigin = apiOrigin
    .replace(/^http:/, "ws:")
    .replace(/^https:/, "wss:");
  return Array.from(
    new Set(["'self'", apiOrigin, wsOrigin, styleOrigin, aerialOrigin]),
  );
}

export function buildContentSecurityPolicy(nonce: string): string {
  const scriptSources = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"];
  if (process.env.NODE_ENV !== "production") {
    // React Refresh evaluates patches in dev; never shipped.
    scriptSources.push("'unsafe-eval'");
  }

  const directives = [
    "default-src 'self'",
    `script-src ${scriptSources.join(" ")}`,
    // Tailwind v4 + Next inject style elements at runtime.
    "style-src 'self' 'unsafe-inline'",
    // blob:/data: — MapLibre sprite atlases, marker canvases, photo previews.
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src ${connectSources().join(" ")}`,
    // MapLibre runs its tile workers from blob: URLs.
    "worker-src 'self' blob:",
    "media-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    // Nothing iframes the companion: the /embed/* routes are legacy
    // redirects to the shared pages, which are linked, not embedded. If a
    // partner-embed feature ever ships, this directive is where it starts.
    "frame-ancestors 'none'",
  ];

  if (process.env.NODE_ENV === "production") {
    directives.push("upgrade-insecure-requests");
  }

  return directives.join("; ");
}

export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
