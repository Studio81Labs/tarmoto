import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs';

export type AppleIapEnvironment = 'Sandbox' | 'Production';

/**
 * Reads the `TARMOTO_APPLE_IAP_*` env vars for Apple StoreKit purchase
 * validation (P1a — see docs/superpowers/plans). Mirrors
 * `StripeNodeBillingClient`'s env-read shape: trimmed reads, null when
 * unset, and an `isConfigured()` gate so callers can fail closed instead
 * of constructing an `@apple/app-store-server-library` client with garbage
 * credentials.
 *
 * `privateKey` accepts either a filesystem path to the Apple-issued
 * `.p8` key or the key contents directly — production deploys can mount
 * the key as a file, while local/CI setups can inline it (the same
 * `.p8` "path or contents" convenience documented, though not actually
 * implemented, on `ApnProviderConfig.key` for push).
 */
@Injectable()
export class AppleIapConfig {
  readonly issuerId: string | null;
  readonly keyId: string | null;
  readonly privateKey: string | null;
  readonly bundleId: string | null;
  readonly environment: AppleIapEnvironment;
  /**
   * Directory holding the Apple-published root `.cer` certificates the
   * `SignedDataVerifier` trusts. Required for `verifyTransaction`; ops mounts
   * it and it is deliberately NOT folded into {@link isConfigured} (see the
   * class doc) so the billing client can fail closed with a clear
   * `ServiceUnavailableException` only on the verification path.
   */
  readonly rootCertDir: string | null;
  /**
   * Numeric App Store app id (`appAppleId`) — Apple's
   * `SignedDataVerifier`/`AppStoreServerAPIClient` want it as a number, so it
   * is parsed here. Unset or unparseable → null (Apple omits it in Sandbox).
   */
  readonly appAppleId: number | null;

  constructor(config: ConfigService) {
    // Core credentials use `|| null` (not `?? null`): a set-but-blank
    // (empty-after-trim) value must normalize to `null` just like an unset
    // one, so `isConfigured()` reports unconfigured instead of passing an
    // empty string into the verifier/API client — an empty `bundleId` would
    // otherwise make valid transactions fail verification as terminal 400s,
    // and blank API credentials would produce indefinitely retryable
    // failures instead of a clear unconfigured state. `?? null` only
    // substitutes for `null`/`undefined`, so a blank string previously
    // survived it unchanged.
    this.issuerId =
      config.get<string>('TARMOTO_APPLE_IAP_ISSUER_ID')?.trim() || null;
    this.keyId = config.get<string>('TARMOTO_APPLE_IAP_KEY_ID')?.trim() || null;
    this.privateKey = resolvePrivateKey(
      config.get<string>('TARMOTO_APPLE_IAP_PRIVATE_KEY')?.trim() || undefined,
    );
    this.bundleId =
      config.get<string>('TARMOTO_APPLE_IAP_BUNDLE_ID')?.trim() || null;
    this.environment = parseEnvironment(
      config.get<string>('TARMOTO_APPLE_IAP_ENVIRONMENT')?.trim(),
    );
    this.rootCertDir =
      config.get<string>('TARMOTO_APPLE_IAP_ROOT_CERT_DIR')?.trim() ?? null;
    this.appAppleId = parseAppAppleId(
      config.get<string>('TARMOTO_APPLE_IAP_APP_APPLE_ID')?.trim(),
    );
  }

  /**
   * True when the core credentials are present AND, in `Production`, a
   * valid `appAppleId` is also present. Apple's `SignedDataVerifier`
   * REQUIRES the numeric app id to verify Production transactions — passing
   * `undefined` there does not degrade gracefully, it makes every
   * verification fail with a terminal `VerificationException`. Reporting
   * unconfigured instead lets the billing client fail closed with a
   * retryable 503 rather than silently rejecting every charged purchase. In
   * `Sandbox` the app id stays optional (Apple omits it there), so
   * `isConfigured()` depends only on the core credentials.
   */
  isConfigured(): boolean {
    const coreConfigured =
      this.issuerId != null &&
      this.keyId != null &&
      this.privateKey != null &&
      this.bundleId != null;
    if (!coreConfigured) {
      return false;
    }
    return this.environment !== 'Production' || this.appAppleId != null;
  }
}

/**
 * Resolves `TARMOTO_APPLE_IAP_PRIVATE_KEY` as a file path when it points
 * at an existing file, otherwise treats it as the literal key contents
 * (un-escaping `\n` the same way `TARMOTO_FCM_PRIVATE_KEY` does, so a
 * PEM pasted as a single-line env value survives round-tripping).
 *
 * The caller normalizes a blank (empty-after-trim) value to `undefined`
 * before calling this, so `raw` is never `''` here — but the `!raw` guard
 * below independently treats an empty string as absent too, ensuring a
 * blank value is NEVER passed to `fs.existsSync` (an empty string must not
 * be treated as a path).
 */
function resolvePrivateKey(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }
  if (fs.existsSync(raw)) {
    return fs.readFileSync(raw, 'utf8');
  }
  return raw.replace(/\\n/g, '\n');
}

/**
 * Parses `TARMOTO_APPLE_IAP_ENVIRONMENT` into the `AppleIapEnvironment`
 * `SignedDataVerifier` is constructed with. Unset defaults to `Sandbox` (the
 * documented default), but a value that IS set must match one of the two
 * documented values exactly — a typo or casing variant (`production`,
 * `PRODUCTION`, `prod`) must fail loudly at startup rather than silently
 * defaulting to `Sandbox`, which would otherwise make `SignedDataVerifier`
 * reject valid Production transactions as an environment mismatch.
 */
function parseEnvironment(raw: string | undefined): AppleIapEnvironment {
  if (!raw) {
    return 'Sandbox';
  }
  if (raw === 'Sandbox' || raw === 'Production') {
    return raw;
  }
  throw new Error(
    `TARMOTO_APPLE_IAP_ENVIRONMENT must be "Sandbox" or "Production", got "${raw}"`,
  );
}

/**
 * Parses `TARMOTO_APPLE_IAP_APP_APPLE_ID` into the numeric app apple id
 * Apple's library expects. Accepts ONLY a strict positive integer — the
 * trimmed value must match `/^\d+$/` and parse to a number `> 0`. Returns
 * null for unset, non-numeric, zero/negative, or trailing-garbage values
 * (e.g. `"123abc"`, which `Number.parseInt` would otherwise silently accept
 * as `123`), so the billing client can pass `undefined` through unchanged
 * and `isConfigured()` can treat a malformed value the same as an unset one.
 */
function parseAppAppleId(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return parsed > 0 ? parsed : null;
}
