import type { CrashAlertSeverity } from '../../entities/crash-alert.entity.js';

export type CrashAlertChannel = 'sms' | 'voice';

export interface CrashAlertRecipient {
  contact_id: string;
  name: string;
  phone: string;
}

export interface CrashAlertContext {
  alert_id: string;
  rider_name: string;
  lat: number;
  lng: number;
  maps_link: string;
  ride_id: string | null;
  speed_kmh: number | null;
  severity: CrashAlertSeverity;
  /** ISO8601 timestamp of the alert */
  timestamp: string;
  /** Localized message text already rendered for the recipient */
  message: string;
}

export interface CrashAlertDispatchResult {
  channel: CrashAlertChannel;
  /** Provider-side identifier (e.g. Twilio SID) when available */
  provider_message_id: string | null;
}

/**
 * Pluggable dispatcher for crash alerts.
 *
 * Implementations send a single message to a single recipient over the
 * given channel. Throwing surfaces the failure to the caller, which
 * records it in the per-contact audit row but does not abort the
 * overall request — see `SafetyService.sendCrashAlert`.
 *
 * Implementations should be idempotent at the provider level when
 * possible (Twilio dedupes by `idempotencyKey`), but the safety
 * service also gates dispatch off the `crash_alerts.id` row to
 * guarantee no double-send across retries.
 */
export interface CrashAlertNotifier {
  /** Provider name surfaced in logs and audit rows. */
  readonly name: string;

  /** True when the provider has the credentials to actually send messages. */
  isConfigured(): boolean;

  send(
    channel: CrashAlertChannel,
    recipient: CrashAlertRecipient,
    context: CrashAlertContext,
  ): Promise<CrashAlertDispatchResult>;
}

/**
 * Injection token for the notifier. Swap implementations in
 * `SafetyModule` to add MessageBird, Vonage, etc.
 */
export const CRASH_ALERT_NOTIFIER = 'CRASH_ALERT_NOTIFIER';
