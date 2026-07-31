import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AppleIapConfig } from './apple-iap.config.js';

const fakeConfigService = (
  env: Record<string, string | undefined>,
): ConfigService =>
  ({
    get: <T>(key: string): T | undefined => env[key] as T | undefined,
  }) as unknown as ConfigService;

describe('AppleIapConfig', () => {
  it('isConfigured() is false and environment defaults to Sandbox when unset', () => {
    const config = new AppleIapConfig(fakeConfigService({}));

    expect(config.isConfigured()).toBe(false);
    expect(config.issuerId).toBeNull();
    expect(config.keyId).toBeNull();
    expect(config.privateKey).toBeNull();
    expect(config.bundleId).toBeNull();
    expect(config.environment).toBe('Sandbox');
    expect(config.rootCertDir).toBeNull();
    expect(config.appAppleId).toBeNull();
  });

  it('isConfigured() is true and parses trimmed values when all vars are set', () => {
    const config = new AppleIapConfig(
      fakeConfigService({
        TARMOTO_APPLE_IAP_ISSUER_ID: ' 69a6de70-... ',
        TARMOTO_APPLE_IAP_KEY_ID: ' ABC123DEFG ',
        TARMOTO_APPLE_IAP_PRIVATE_KEY:
          ' -----BEGIN PRIVATE KEY-----\\nabc123\\n-----END PRIVATE KEY----- ',
        TARMOTO_APPLE_IAP_BUNDLE_ID: ' app.tarmoto.ios ',
        TARMOTO_APPLE_IAP_ENVIRONMENT: 'Production',
        TARMOTO_APPLE_IAP_ROOT_CERT_DIR: ' /etc/apple/roots ',
        TARMOTO_APPLE_IAP_APP_APPLE_ID: ' 6448312345 ',
      }),
    );

    expect(config.isConfigured()).toBe(true);
    expect(config.issuerId).toBe('69a6de70-...');
    expect(config.keyId).toBe('ABC123DEFG');
    expect(config.privateKey).toBe(
      '-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----',
    );
    expect(config.bundleId).toBe('app.tarmoto.ios');
    expect(config.environment).toBe('Production');
    expect(config.rootCertDir).toBe('/etc/apple/roots');
    expect(config.appAppleId).toBe(6448312345);
  });

  it('appAppleId is null when the value is not a valid integer', () => {
    const config = new AppleIapConfig(
      fakeConfigService({ TARMOTO_APPLE_IAP_APP_APPLE_ID: 'not-a-number' }),
    );

    expect(config.appAppleId).toBeNull();
  });

  it('rootCertDir and appAppleId do not participate in isConfigured()', () => {
    const config = new AppleIapConfig(
      fakeConfigService({
        TARMOTO_APPLE_IAP_ISSUER_ID: 'issuer',
        TARMOTO_APPLE_IAP_KEY_ID: 'key',
        TARMOTO_APPLE_IAP_PRIVATE_KEY: 'inline-key',
        TARMOTO_APPLE_IAP_BUNDLE_ID: 'app.tarmoto.ios',
      }),
    );

    // The five credential vars are set but the cert dir / app id are not — the
    // config still reports configured (the billing client fails closed on the
    // verification path instead).
    expect(config.isConfigured()).toBe(true);
    expect(config.rootCertDir).toBeNull();
    expect(config.appAppleId).toBeNull();
  });

  it('defaults environment to Sandbox for any value other than "Production"', () => {
    const config = new AppleIapConfig(
      fakeConfigService({ TARMOTO_APPLE_IAP_ENVIRONMENT: 'production' }),
    );

    expect(config.environment).toBe('Sandbox');
  });

  it('isConfigured() is false when only some required vars are set', () => {
    const config = new AppleIapConfig(
      fakeConfigService({
        TARMOTO_APPLE_IAP_ISSUER_ID: 'issuer',
        TARMOTO_APPLE_IAP_KEY_ID: 'key',
      }),
    );

    expect(config.isConfigured()).toBe(false);
  });

  it('reads the private key from a file path when the value is an existing file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-iap-config-'));
    const keyPath = path.join(dir, 'AuthKey.p8');
    fs.writeFileSync(
      keyPath,
      '-----BEGIN PRIVATE KEY-----\nfromfile\n-----END PRIVATE KEY-----\n',
    );

    try {
      const config = new AppleIapConfig(
        fakeConfigService({ TARMOTO_APPLE_IAP_PRIVATE_KEY: keyPath }),
      );

      expect(config.privateKey).toBe(
        '-----BEGIN PRIVATE KEY-----\nfromfile\n-----END PRIVATE KEY-----\n',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
