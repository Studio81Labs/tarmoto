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
    this.issuerId =
      config.get<string>('TARMOTO_APPLE_IAP_ISSUER_ID')?.trim() ?? null;
    this.keyId = config.get<string>('TARMOTO_APPLE_IAP_KEY_ID')?.trim() ?? null;
    this.privateKey = resolvePrivateKey(
      config.get<string>('TARMOTO_APPLE_IAP_PRIVATE_KEY')?.trim(),
    );
    this.bundleId =
      config.get<string>('TARMOTO_APPLE_IAP_BUNDLE_ID')?.trim() ?? null;
    this.environment =
      config.get<string>('TARMOTO_APPLE_IAP_ENVIRONMENT')?.trim() ===
      'Production'
        ? 'Production'
        : 'Sandbox';
    this.rootCertDir =
      config.get<string>('TARMOTO_APPLE_IAP_ROOT_CERT_DIR')?.trim() ?? null;
    this.appAppleId = parseAppAppleId(
      config.get<string>('TARMOTO_APPLE_IAP_APP_APPLE_ID')?.trim(),
    );
  }

  isConfigured(): boolean {
    return (
      this.issuerId != null &&
      this.keyId != null &&
      this.privateKey != null &&
      this.bundleId != null
    );
  }
}

/**
 * Resolves `TARMOTO_APPLE_IAP_PRIVATE_KEY` as a file path when it points
 * at an existing file, otherwise treats it as the literal key contents
 * (un-escaping `\n` the same way `TARMOTO_FCM_PRIVATE_KEY` does, so a
 * PEM pasted as a single-line env value survives round-tripping).
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
 * Parses `TARMOTO_APPLE_IAP_APP_APPLE_ID` into the numeric app apple id Apple's
 * library expects. Returns null when unset or when the value is not a valid
 * integer, so the billing client can pass `undefined` through unchanged.
 */
function parseAppAppleId(raw: string | undefined): number | null {
  if (!raw) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}
