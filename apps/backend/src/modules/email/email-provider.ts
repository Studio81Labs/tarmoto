/**
 * Pluggable transport for transactional mail. Implementations live in
 * `providers/` and are selected at module-bootstrap time based on
 * `TARMOTO_EMAIL_PROVIDER`. Templates render to a `RenderedEmail`
 * before they ever reach a provider — providers are dumb pipes that
 * only know how to push fully-rendered content to a delivery
 * channel (HTTP API, SMTP, log file).
 *
 * `name` is surfaced in observability so on-call can see which
 * provider actually delivered (or failed to deliver) a given message.
 */
export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');

export interface RenderedEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  /**
   * Optional headers (e.g. `List-Unsubscribe`). Providers MUST forward
   * supplied headers verbatim — we set bulk-sender headers here, not
   * inside provider implementations.
   */
  headers?: Record<string, string>;
  /**
   * Free-form provider tag. Used by Resend for log filtering and by
   * the `LogProvider` to make dev logs greppable. Optional.
   */
  tag?: string;
}

export interface EmailSendResult {
  /** Provider-issued message id, when the transport returns one. */
  providerMessageId: string | null;
  /** The provider that actually handled the send (post-fallback). */
  providerName: string;
}

export interface EmailProvider {
  readonly name: string;
  send(message: RenderedEmail): Promise<EmailSendResult>;
}
