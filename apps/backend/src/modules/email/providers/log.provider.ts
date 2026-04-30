import { Injectable, Logger } from '@nestjs/common';
import {
  type EmailProvider,
  type EmailSendResult,
  type RenderedEmail,
} from '../email-provider.js';

/**
 * Dev / fallback transport. Writes the full rendered message to the
 * NestJS logger so engineers can grab the verification or reset link
 * out of the dev console without running a real SMTP server.
 *
 * Also activated whenever a real provider's required env vars are
 * missing — keeps the rest of the auth/billing pipeline working
 * locally and in CI without forcing every developer to provision
 * Resend credentials.
 */
@Injectable()
export class LogEmailProvider implements EmailProvider {
  readonly name = 'log';
  private readonly logger = new Logger('EmailProvider:log');

  send(message: RenderedEmail): Promise<EmailSendResult> {
    const tagSuffix = message.tag ? ` [${message.tag}]` : '';
    this.logger.log(
      `→ ${message.to} :: ${message.subject}${tagSuffix}\n${message.text}`,
    );
    return Promise.resolve({
      providerMessageId: null,
      providerName: this.name,
    });
  }
}
