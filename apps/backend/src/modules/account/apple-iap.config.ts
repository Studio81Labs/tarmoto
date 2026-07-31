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
