import { ConfigService } from '@nestjs/config';

/**
 * Password login is enabled in development and test by default.
 * In production it is only enabled when TARMOTO_ADMIN_PASSWORD_LOGIN_ENABLED=true
 * is explicitly set, mirroring the SPA's import.meta.env.DEV default.
 */
export function isAdminPasswordLoginEnabled(config: ConfigService): boolean {
  if (config.get<string>('NODE_ENV') !== 'production') return true;
  return config.get<string>('TARMOTO_ADMIN_PASSWORD_LOGIN_ENABLED') === 'true';
}
