import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";

const appRoot = new URL("./", import.meta.url);

async function readAppFile(path) {
  return readFile(new URL(path, appRoot), "utf8");
}

test("layout declares site-wide social + manifest metadata", async () => {
  const layout = await readAppFile("app/layout.tsx");

  assert.match(layout, /metadataBase:\s*new URL\("https:\/\/tarmoto\.app"\)/);
  assert.match(layout, /applicationName:\s*"Tarmoto"/);
  assert.match(layout, /manifest:\s*"\/site\.webmanifest"/);
  assert.match(layout, /appleWebApp:\s*\{/);
  assert.match(layout, /statusBarStyle:\s*"black-translucent"/);

  assert.match(layout, /apple:\s*\[\{ url:\s*"\/apple-touch-icon\.png"/);

  assert.match(layout, /openGraph:\s*\{/);
  assert.match(layout, /type:\s*"website"/);

  assert.match(layout, /themeColor:\s*"#0B0D10"/);
  assert.match(layout, /colorScheme:\s*"dark"/);
});

test("subpages declare page-specific titles + descriptions", async () => {
  const about = await readAppFile("app/about/page.tsx");
  const contact = await readAppFile("app/contact/page.tsx");
  const privacy = await readAppFile("app/privacy/page.tsx");
  const terms = await readAppFile("app/terms/page.tsx");

  for (const [name, file] of [
    ["about", about],
    ["contact", contact],
    ["privacy", privacy],
    ["terms", terms],
  ]) {
    assert.match(
      file,
      /export const metadata: Metadata = \{/,
      `${name} page must export metadata`,
    );
    assert.match(file, /title:\s*"/, `${name} page must set title`);
    assert.match(file, /description:\s*"/, `${name} page must set description`);
  }
});

test("marketing public favicon + pwa assets are present", () => {
  const expectedAssets = [
    "public/favicon.ico",
    "public/favicon.svg",
    "public/favicon-16x16.png",
    "public/favicon-32x32.png",
    "public/favicon-48x48.png",
    "public/apple-touch-icon.png",
    "public/android-chrome-192x192.png",
    "public/android-chrome-512x512.png",
    "public/site.webmanifest",
  ];

  for (const path of expectedAssets) {
    assert.equal(
      existsSync(new URL(path, appRoot)),
      true,
      `${path} is missing`,
    );
  }
});

test("marketing web manifest uses Tarmoto brand colors and icons", async () => {
  const manifest = JSON.parse(await readAppFile("public/site.webmanifest"));

  assert.equal(manifest.name, "Tarmoto");
  assert.equal(manifest.short_name, "Tarmoto");
  assert.equal(manifest.theme_color, "#FF6A1A");
  assert.equal(manifest.background_color, "#0B0D10");
  assert.deepEqual(
    manifest.icons.map((icon) => icon.src),
    ["/android-chrome-192x192.png", "/android-chrome-512x512.png"],
  );
});
