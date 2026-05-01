import { Injectable, Logger } from '@nestjs/common';
import * as apn from '@parse/node-apn';
import {
  type PushPayload,
  type PushProvider,
  type PushSendResult,
  type PushTarget,
} from '../push-provider.js';

export interface ApnProviderConfig {
  /** Path to the .p8 file or the key contents directly. */
  key: string;
  /** Apple-issued key identifier. */
  keyId: string;
  /** Apple developer team identifier. */
  teamId: string;
  /** App bundle identifier — set as `apns-topic`. */
  topic: string;
  /** Whether to talk to api.push.apple.com vs the sandbox endpoint. */
  production: boolean;
}

/**
 * APN HTTP/2 transport via @parse/node-apn. The library handles the
 * connection pool, JWT signing, and per-token success/failure
 * fan-in — wrapping it in our `PushProvider` shape lets the service
 * stay platform-agnostic.
 *
 * APN responses with `BadDeviceToken`, `Unregistered`, or
 * `DeviceTokenNotForTopic` mean the token is permanently dead and
 * we surface it in `invalidTokens` for soft-delete.
 */
@Injectable()
export class ApnPushProvider implements PushProvider {
  readonly name = 'apn';
  private readonly logger = new Logger('PushProvider:apn');
  private readonly provider: apn.Provider;

  constructor(private readonly config: ApnProviderConfig) {
    this.provider = new apn.Provider({
      token: {
        key: config.key,
        keyId: config.keyId,
        teamId: config.teamId,
      },
      production: config.production,
    });
  }

  async send(
    targets: PushTarget[],
    payload: PushPayload,
  ): Promise<PushSendResult> {
    const tokens = targets.map((t) => t.token);
    if (tokens.length === 0) {
      return { delivered: 0, invalidTokens: [], providerName: this.name };
    }

    const note = new apn.Notification();
    note.topic = this.config.topic;
    note.alert = { title: payload.title, body: payload.body };
    note.sound = 'default';
    if (payload.data) {
      note.payload = { data: payload.data };
    }
    if (payload.category) {
      // `collapse-id` dedupes stacked alerts of the same category
      // in the system tray — see the `collapseKey` rationale on the
      // FCM side.
      note.collapseId = payload.category;
    }

    let result: apn.Responses<apn.ResponseSent, apn.ResponseFailure>;
    try {
      result = await this.provider.send(note, tokens);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `APN batch failed (count=${tokens.length} category=${payload.category ?? 'none'}): ${reason}`,
      );
      return { delivered: 0, invalidTokens: [], providerName: this.name };
    }

    const invalidTokens: string[] = [];
    for (const failure of result.failed) {
      const reason = failure.response?.reason;
      if (
        reason === 'BadDeviceToken' ||
        reason === 'Unregistered' ||
        reason === 'DeviceTokenNotForTopic'
      ) {
        invalidTokens.push(failure.device);
      }
    }

    if (result.failed.length > 0) {
      this.logger.warn(
        `APN partial failure: success=${result.sent.length} ` +
          `failure=${result.failed.length} invalid=${invalidTokens.length}`,
      );
    }

    return {
      delivered: result.sent.length,
      invalidTokens,
      providerName: this.name,
    };
  }

  /**
   * Stop the underlying HTTP/2 connection pool. Nest calls this on
   * module shutdown via the `OnModuleDestroy` lifecycle hook (wired
   * in the module file).
   */
  shutdown(): void {
    // node-apn returns a promise but we don't need to wait for the
    // graceful close before Nest finishes its shutdown sequence —
    // any in-flight pushes are already best-effort. `void` silences
    // `no-floating-promises` while making the intent explicit.
    void this.provider.shutdown();
  }
}
