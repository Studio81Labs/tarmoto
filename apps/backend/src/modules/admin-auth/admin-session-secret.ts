import { ConfigService } from '@nestjs/config';

const DEV_FALLBACK_SECRET = 'dev-only-admin-secret-do-not-use-in-production';

export function resolveAdminSessionSecret(config: ConfigService): string {
  const secret = config.get<string>('TARMOTO_ADMIN_AUTH_SESSION_SECRET');
  if (secret && secret.trim().length > 0) {
    return secret.trim();
  }
  if (config.get<string>('NODE_ENV') === 'production') {
    throw new Error(
      'TARMOTO_ADMIN_AUTH_SESSION_SECRET must be set in production',
    );
  }
  return DEV_FALLBACK_SECRET;
}
