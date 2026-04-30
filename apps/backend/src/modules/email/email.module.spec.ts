import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { emailProviderFactory } from './email.module.js';
import { LogEmailProvider } from './providers/log.provider.js';
import { ResendEmailProvider } from './providers/resend.provider.js';

const buildConfig = (
  entries: Record<string, string | undefined>,
): ConfigService =>
  ({
    get: jest.fn((key: string): string | undefined => entries[key]),
  }) as unknown as ConfigService;

describe('emailProviderFactory', () => {
  let warnSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    // Suppress the Nest bootstrap logs during the assertion-light
    // happy-path tests, and capture them for the fallback assertion.
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('returns a LogEmailProvider when TARMOTO_EMAIL_PROVIDER is unset', () => {
    const provider = emailProviderFactory(buildConfig({}));
    expect(provider).toBeInstanceOf(LogEmailProvider);
    expect(provider.name).toBe('log');
  });

  it('falls back to LogEmailProvider with a startup warning when resend is selected without credentials', () => {
    const provider = emailProviderFactory(
      buildConfig({ TARMOTO_EMAIL_PROVIDER: 'resend' }),
    );
    expect(provider).toBeInstanceOf(LogEmailProvider);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('returns a ResendEmailProvider when TARMOTO_EMAIL_PROVIDER=resend with credentials', () => {
    const provider = emailProviderFactory(
      buildConfig({
        TARMOTO_EMAIL_PROVIDER: 'resend',
        TARMOTO_RESEND_API_KEY: 're_live_xxx',
        TARMOTO_EMAIL_FROM: 'Tarmoto <noreply@tarmoto.app>',
      }),
    );
    expect(provider).toBeInstanceOf(ResendEmailProvider);
    expect(provider.name).toBe('resend');
  });

  it('falls back to LogEmailProvider for an unknown provider name', () => {
    const provider = emailProviderFactory(
      buildConfig({ TARMOTO_EMAIL_PROVIDER: 'mailwhoami' }),
    );
    expect(provider).toBeInstanceOf(LogEmailProvider);
    expect(warnSpy).toHaveBeenCalled();
  });
});
