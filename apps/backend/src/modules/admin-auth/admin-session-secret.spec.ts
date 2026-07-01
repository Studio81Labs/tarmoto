import { ConfigService } from '@nestjs/config';
import { resolveAdminSessionSecret } from './admin-session-secret.js';

function configWith(values: Record<string, string | undefined>): ConfigService {
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

describe('resolveAdminSessionSecret', () => {
  it('returns the configured secret', () => {
    const secret = resolveAdminSessionSecret(
      configWith({
        TARMOTO_ADMIN_AUTH_SESSION_SECRET: 'super-secret-value-1234',
      }),
    );
    expect(secret).toBe('super-secret-value-1234');
  });

  it('falls back to a dev secret outside production', () => {
    const secret = resolveAdminSessionSecret(
      configWith({ NODE_ENV: 'development' }),
    );
    expect(secret.length).toBeGreaterThan(0);
  });

  it('throws when unset in production', () => {
    expect(() =>
      resolveAdminSessionSecret(configWith({ NODE_ENV: 'production' })),
    ).toThrow(/TARMOTO_ADMIN_AUTH_SESSION_SECRET/);
  });
});
