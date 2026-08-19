// Fixture for .semgrep/tarmoto-rn.yaml, scanned by security-scan.yml and
// checked line-by-line by scripts/ci/check-semgrep-fixture.py.
//
// `// ruleid: <id>` above a line means that rule MUST fire there;
// `// ok: <id>` means it MUST NOT. The checker also rejects any finding on a
// line carrying neither, so every match in this file is deliberate.
//
// This file is never imported, compiled, or type-checked — semgrep parses it,
// nothing else reads it. The credential-shaped strings and userinfo URLs are
// the point (they are bypass regression cases), which is why
// .semgrep/trufflehog-exclude.txt exempts exactly this file from the secrets
// scanner.

declare const storage: { set(key: string, value: string): void };
declare const tokenStorage: { set(key: string, value: string): void };
declare const seen: Map<string, string>;
declare const auth: { access_token: string; refresh_token: string };
declare const accessToken: string;
declare const refreshToken: string;
declare const apiHost: string;
declare const count: number;

export function fixture(): void {
  // --- tarmoto-rn-secret-in-mmkv -------------------------------------------

  // The key names the credential, as a string literal.
  // ruleid: tarmoto-rn-secret-in-mmkv
  storage.set("access_token", auth.access_token);
  // The key names the credential through an identifier (the app's real shape:
  // typedClient.ts writes ACCESS_TOKEN_KEY / REFRESH_TOKEN_KEY).
  const REFRESH_TOKEN_KEY = "rt";
  // ruleid: tarmoto-rn-secret-in-mmkv
  tokenStorage.set(REFRESH_TOKEN_KEY, auth.refresh_token);
  // VALUE branch: an innocuous key hiding a credential value — renaming the
  // key must not defeat the rule.
  // ruleid: tarmoto-rn-secret-in-mmkv
  storage.set("session", accessToken);
  // Snake_case value from a DTO field.
  // ruleid: tarmoto-rn-secret-in-mmkv
  storage.set("session", auth.refresh_token);
  // Non-secret key and value: plain preference writes stay legal.
  // ok: tarmoto-rn-secret-in-mmkv
  storage.set("theme", "dark");
  // "token_count" contains no credential name (token_key/access_token/...),
  // and a stringified number is not identifier-shaped.
  // ok: tarmoto-rn-secret-in-mmkv
  storage.set("token_count", String(count));
  // An in-memory Map is not a disk write — the receiver constraint keeps
  // ordinary collections out.
  // ok: tarmoto-rn-secret-in-mmkv
  seen.set("access_token", accessToken);

  // --- tarmoto-rn-secret-in-logs -------------------------------------------

  // ruleid: tarmoto-rn-secret-in-logs
  console.log(accessToken);
  // The credential in a later argument — a first-argument-only pattern never
  // binds this.
  // ruleid: tarmoto-rn-secret-in-logs
  console.error("auth refresh failed", refreshToken);
  // Interpolated into a template literal.
  // ruleid: tarmoto-rn-secret-in-logs
  console.warn(`refresh failed for ${refreshToken}`);
  // Shorthand object property still carries the value off-device.
  // ruleid: tarmoto-rn-secret-in-logs
  console.debug({ accessToken });
  // Snake_case DTO field.
  // ruleid: tarmoto-rn-secret-in-logs
  console.info("got", auth.access_token);
  // A bare `token` in prose is a progress message, not a credential — the
  // shape that forced bare `token` out of the regex.
  // ok: tarmoto-rn-secret-in-logs
  console.log("token refresh completed");
  // ok: tarmoto-rn-secret-in-logs
  console.log("user signed in");

  // --- tarmoto-rn-insecure-http-url ----------------------------------------

  // ruleid: tarmoto-rn-insecure-http-url
  const plain = "http://api.example.com/v1";
  // Scheme case must not matter.
  // ruleid: tarmoto-rn-insecure-http-url
  const shouty = "HTTP://api.example.com/v1";
  // Userinfo bypass: the authority puts a loopback-looking name before `@`,
  // so the real host is remote.
  // ruleid: tarmoto-rn-insecure-http-url
  const sneaky = "http://localhost:3000@api.example.com/v1";
  // Prefix bypass: a host that merely STARTS with localhost.
  // ruleid: tarmoto-rn-insecure-http-url
  const prefixed = "http://localhost.attacker.example/v1";
  // An interpolated host is not exempt — it is plaintext whatever it
  // resolves to.
  // ruleid: tarmoto-rn-insecure-http-url
  const templated = `http://${apiHost}/v1`;
  // Loopback and the Android emulator host are the local-dev path
  // (src/config.ts uses 10.0.2.2).
  // ok: tarmoto-rn-insecure-http-url
  const local = "http://localhost:3000";
  // ok: tarmoto-rn-insecure-http-url
  const loop = "http://127.0.0.1:8080/path";
  // ok: tarmoto-rn-insecure-http-url
  const emulator = "http://10.0.2.2:3000";
  // ok: tarmoto-rn-insecure-http-url
  const v6 = "http://[::1]:3000";
  // ok: tarmoto-rn-insecure-http-url
  const tls = "https://api.tarmoto.app";

  void [plain, shouty, sneaky, prefixed, templated, local, loop, emulator, v6, tls, REFRESH_TOKEN_KEY];
}
