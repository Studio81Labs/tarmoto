import { Logger, Module, type Provider } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EmailLog } from '../../entities/email-log.entity.js';
import { EmailTemplate } from '../../entities/email-template.entity.js';
import { EMAIL_PROVIDER, type EmailProvider } from './email-provider.js';
import { EmailService } from './email.service.js';
import { LogEmailProvider } from './providers/log.provider.js';
import {
  ResendEmailProvider,
  type ResendProviderConfig,
} from './providers/resend.provider.js';

const BOOTSTRAP_LOGGER = new Logger('EmailModule');

const emailProviderFactory = (config: ConfigService): EmailProvider => {
  // Truthy fallback (`||` not `??`): a blank or whitespace-only
  // `TARMOTO_EMAIL_PROVIDER` would otherwise pass through as `''`,
  // miss both the `log` and `resend` branches, and trip the
  // "Unknown TARMOTO_EMAIL_PROVIDER" warning instead of silently
  // landing on the dev/CI default. Same rationale as the trim+`||`
  // pattern in `common/companion-url.ts`.
  const raw =
    config.get<string>('TARMOTO_EMAIL_PROVIDER')?.trim().toLowerCase() || 'log';
  const requested: 'log' | 'resend' | 'unknown' =
    raw === 'log' || raw === 'resend' ? raw : 'unknown';

  if (requested === 'resend') {
    const apiKey = config.get<string>('TARMOTO_RESEND_API_KEY')?.trim();
    const from = config.get<string>('TARMOTO_EMAIL_FROM')?.trim();
    if (!apiKey || !from) {
      // Per AC: missing config logs a startup warning and falls back
      // to logging. We don't throw — local dev and CI routinely boot
      // without real provider creds, and forcing an exception there
      // would break unrelated CI flows. Production ops folks see the
      // warning in the boot log.
      BOOTSTRAP_LOGGER.warn(
        'TARMOTO_EMAIL_PROVIDER=resend but TARMOTO_RESEND_API_KEY ' +
          'and/or TARMOTO_EMAIL_FROM are not set. Falling back to ' +
          'the log provider — outbound mail will only appear in ' +
          'the application logs, not in real inboxes.',
      );
      return new LogEmailProvider();
    }
    const replyTo = config.get<string>('TARMOTO_EMAIL_REPLY_TO')?.trim();
    const cfg: ResendProviderConfig = { apiKey, from };
    if (replyTo) cfg.replyTo = replyTo;
    BOOTSTRAP_LOGGER.log(`Email provider: resend (from=${from})`);
    return new ResendEmailProvider(cfg);
  }

  if (requested === 'unknown') {
    BOOTSTRAP_LOGGER.warn(
      `Unknown TARMOTO_EMAIL_PROVIDER="${raw}". Falling back to the log provider.`,
    );
  } else {
    BOOTSTRAP_LOGGER.log('Email provider: log (dev / fallback)');
  }
  return new LogEmailProvider();
};

const emailProvider: Provider = {
  provide: EMAIL_PROVIDER,
  inject: [ConfigService],
  useFactory: emailProviderFactory,
};

@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([EmailLog, EmailTemplate])],
  providers: [emailProvider, EmailService],
  exports: [EmailService],
})
export class EmailModule {}

export { emailProviderFactory };
