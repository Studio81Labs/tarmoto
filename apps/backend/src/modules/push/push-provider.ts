import type { DevicePlatform } from '@tarmoto/shared';

/**
 * Pluggable transport for outbound push. Implementations live in
 * `providers/` and are selected at module-bootstrap time based on
 * `TARMOTO_PUSH_PROVIDER`. Mirrors the `EmailProvider` shape.
 *
 * Providers are dumb pipes — the service is responsible for
 * preference gating, quiet hours, token loading, and post-send
 * cleanup. A provider only knows: "deliver this rendered payload to
 * these tokens; tell me which ones came back unrecoverable."
 */
export const PUSH_PROVIDER = Symbol('PUSH_PROVIDER');

export interface PushTarget {
  platform: DevicePlatform;
  token: string;
}

export interface PushPayload {
  title: string;
  body: string;
  /**
   * Free-form structured data the mobile app reads on tap. Backend
   * keeps this small (FCM has a 4 KB total payload limit). Always
   * stringify-friendly — providers JSON-encode for transport.
   */
  data?: Record<string, string>;
  /**
   * Provider-side category tag. Used for log filtering and (on iOS)
   * APN `apns-collapse-id` to dedupe stacked alerts of the same
   * category.
   */
  category?: string;
}

export interface PushSendResult {
  /** Total tokens the provider accepted. */
  delivered: number;
  /**
   * Tokens the provider reported as unrecoverable (FCM
   * `UNREGISTERED` / `INVALID_ARGUMENT`, APN `Unregistered` /
   * `BadDeviceToken`). Service uses this to soft-delete the rows
   * so the next dispatch doesn't re-send to a dead handle.
   */
  invalidTokens: string[];
  /** Provider name surfaced in observability. */
  providerName: string;
}

export interface PushProvider {
  readonly name: string;
  send(targets: PushTarget[], payload: PushPayload): Promise<PushSendResult>;
}
