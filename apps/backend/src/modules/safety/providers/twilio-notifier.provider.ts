import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  CrashAlertChannel,
  CrashAlertContext,
  CrashAlertDispatchResult,
  CrashAlertNotifier,
  CrashAlertRecipient,
} from '../crash-alert-notifier.interface.js';

interface TwilioMessageResponse {
  sid?: string;
  status?: string;
  message?: string;
  code?: number;
}

/**
 * Hard cap on a single Twilio HTTP call. Crash dispatch is a
 * safety-critical synchronous flow — a blackholed Twilio request
 * must never hang the request and keep the audit row in-flight for
 * minutes (which would block legitimate replays and defer the
 * stale-reclaim window).
 */
const TWILIO_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Twilio implementation of {@link CrashAlertNotifier}.
 *
 * Configured via:
 *   - `TARMOTO_TWILIO_ACCOUNT_SID`   (required to enable real dispatch)
 *   - `TARMOTO_TWILIO_AUTH_TOKEN`    (required)
 *   - `TARMOTO_TWILIO_FROM_NUMBER`   (required, E.164)
 *   - `TARMOTO_TWILIO_VOICE_TWIML_URL` (optional, used for severity=high
 *     voice fallback; if unset, voice falls back to a Say-only TwiML
 *     served by Twilio's `twimlets.com/echo`-style helper, which we
 *     avoid in favour of a synchronous `Twiml` parameter)
 *
 * If credentials are missing the provider stays in log-only mode so
 * dev/CI continue to pass without secrets. Callers can detect this via
 * `isConfigured()` before deciding whether to attempt voice dispatch.
 */
@Injectable()
export class TwilioCrashAlertNotifier implements CrashAlertNotifier {
  readonly name = 'twilio';

  private readonly logger = new Logger(TwilioCrashAlertNotifier.name);
  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly fromNumber: string;
  private readonly voiceTwimlUrl: string;
  private readonly configured: boolean;

  constructor(private readonly config: ConfigService) {
    this.accountSid = this.config.get<string>('TARMOTO_TWILIO_ACCOUNT_SID', '');
    this.authToken = this.config.get<string>('TARMOTO_TWILIO_AUTH_TOKEN', '');
    this.fromNumber = this.config.get<string>('TARMOTO_TWILIO_FROM_NUMBER', '');
    this.voiceTwimlUrl = this.config.get<string>(
      'TARMOTO_TWILIO_VOICE_TWIML_URL',
      '',
    );

    this.configured =
      this.accountSid.length > 0 &&
      this.authToken.length > 0 &&
      this.fromNumber.length > 0;

    if (!this.configured) {
      this.logger.warn(
        'Twilio crash-alert notifier disabled — set TARMOTO_TWILIO_ACCOUNT_SID, ' +
          'TARMOTO_TWILIO_AUTH_TOKEN, and TARMOTO_TWILIO_FROM_NUMBER to enable. ' +
          'Crash alerts will fall back to log-only.',
      );
    }
  }

  isConfigured(): boolean {
    return this.configured;
  }

  async send(
    channel: CrashAlertChannel,
    recipient: CrashAlertRecipient,
    context: CrashAlertContext,
  ): Promise<CrashAlertDispatchResult> {
    if (!this.configured) {
      // Fallback so dev/test (and prod with mis-configured env) still
      // produces a structured audit trail rather than a hard failure.
      this.logger.warn(
        `[crash-alert ${context.alert_id}] log-only ${channel} to ` +
          `${recipient.name} (${recipient.phone}): ${context.message}`,
      );
      return { channel, provider_message_id: null };
    }

    if (channel === 'voice') {
      return this.sendVoice(recipient, context);
    }
    return this.sendSms(recipient, context);
  }

  private async sendSms(
    recipient: CrashAlertRecipient,
    context: CrashAlertContext,
  ): Promise<CrashAlertDispatchResult> {
    const params = new URLSearchParams({
      To: recipient.phone,
      From: this.fromNumber,
      Body: context.message,
    });

    const response = await this.postToTwilio(
      `Accounts/${this.accountSid}/Messages.json`,
      params,
      `${context.alert_id}:${recipient.contact_id}:sms`,
    );

    return { channel: 'sms', provider_message_id: response.sid ?? null };
  }

  private async sendVoice(
    recipient: CrashAlertRecipient,
    context: CrashAlertContext,
  ): Promise<CrashAlertDispatchResult> {
    const params = new URLSearchParams({
      To: recipient.phone,
      From: this.fromNumber,
    });

    if (this.voiceTwimlUrl) {
      params.set('Url', this.voiceTwimlUrl);
    } else {
      // Inline TwiML — Twilio accepts a `Twiml` parameter so we can
      // dispatch a voice alert without hosting a callback URL.
      // Entity-encode XML special characters rather than dropping
      // them: a rider whose display name is `Jonas & Co` deserves to
      // have the ampersand spoken, not silently elided.
      const safe = context.message
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      params.set('Twiml', `<Response><Say>${safe}</Say></Response>`);
    }

    const response = await this.postToTwilio(
      `Accounts/${this.accountSid}/Calls.json`,
      params,
      `${context.alert_id}:${recipient.contact_id}:voice`,
    );

    return { channel: 'voice', provider_message_id: response.sid ?? null };
  }

  private async postToTwilio(
    path: string,
    params: URLSearchParams,
    idempotencyKey: string,
  ): Promise<TwilioMessageResponse> {
    const url = `https://api.twilio.com/2010-04-01/${path}`;
    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString(
      'base64',
    );

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      TWILIO_REQUEST_TIMEOUT_MS,
    );

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'I-Twilio-Idempotency-Token': idempotencyKey,
        },
        body: params.toString(),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(
          `Twilio API timeout after ${TWILIO_REQUEST_TIMEOUT_MS}ms`,
          { cause: err },
        );
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    let body: TwilioMessageResponse = {};
    try {
      body = (await response.json()) as TwilioMessageResponse;
    } catch {
      // Non-JSON error body — fall through with empty object.
    }

    if (!response.ok) {
      const detail =
        body.message ?? `${response.status} ${response.statusText}`;
      throw new Error(`Twilio API error: ${detail}`);
    }
    return body;
  }
}
