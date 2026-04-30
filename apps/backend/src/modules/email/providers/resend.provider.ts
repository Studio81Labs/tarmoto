import { Injectable, Logger } from '@nestjs/common';
import {
  type EmailProvider,
  type EmailSendResult,
  type RenderedEmail,
} from '../email-provider.js';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

interface ResendApiResponse {
  id?: string;
  message?: string;
  name?: string;
}

export interface ResendProviderConfig {
  apiKey: string;
  /** Verified `From:` address — e.g. `Tarmoto <noreply@tarmoto.app>`. */
  from: string;
  /** Optional reply-to (typically `support@`). */
  replyTo?: string;
}

/**
 * Resend HTTP API transport. Resend's API is a single POST per send
 * with a tiny JSON body, so a hand-rolled `fetch` keeps the dependency
 * graph minimal — adding the Resend SDK would pull in extra runtime
 * just to wrap one endpoint.
 *
 * The provider does no retry or backoff: transient failures bubble up
 * to the `EmailService` caller, which is expected to log and continue
 * (mail is fire-and-forget — a failed verification mail must not
 * block the registration response, for example).
 */
@Injectable()
export class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend';
  private readonly logger = new Logger('EmailProvider:resend');

  constructor(private readonly config: ResendProviderConfig) {}

  async send(message: RenderedEmail): Promise<EmailSendResult> {
    const payload: Record<string, unknown> = {
      from: this.config.from,
      to: [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
    };
    if (this.config.replyTo) {
      payload['reply_to'] = this.config.replyTo;
    }
    if (message.headers && Object.keys(message.headers).length > 0) {
      payload['headers'] = message.headers;
    }
    if (message.tag) {
      payload['tags'] = [{ name: 'category', value: message.tag }];
    }

    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as ResendApiResponse;
      const detail = body.message ?? body.name ?? res.statusText;
      this.logger.warn(
        `Resend send failed (${res.status}) for ${message.to}: ${detail}`,
      );
      throw new Error(`Resend send failed: ${res.status} ${detail}`);
    }

    const body = (await res.json()) as ResendApiResponse;
    return {
      providerMessageId: body.id ?? null,
      providerName: this.name,
    };
  }
}
