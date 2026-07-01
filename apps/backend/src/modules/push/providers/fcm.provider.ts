import { Injectable, Logger } from '@nestjs/common';
import * as admin from 'firebase-admin';
import {
  type PushPayload,
  type PushProvider,
  type PushSendResult,
  type PushTarget,
} from '../push-provider.js';

export interface FcmProviderConfig {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

/**
 * FCM v1 (HTTP) transport via firebase-admin. The SDK handles OAuth2
 * service-account JWT exchange and HTTP/2 connection pooling, which
 * is more code than we want to own — the dispatch path is best-effort
 * fire-and-forget so we benefit from the SDK's retry-on-5xx without
 * paying for the retry surface ourselves.
 *
 * The provider routes all targets in parallel via `sendEachForMulticast`
 * (FCM caps at 500 tokens per call; we expect single-digit token counts
 * per send because we slice by user). Tokens FCM rejects as terminally
 * dead — `messaging/registration-token-not-registered` and
 * `messaging/invalid-argument` — are returned in `invalidTokens` so
 * the service can soft-delete the row.
 *
 * If the provider key files aren't on disk we never reach this class —
 * the module factory falls back to `LogPushProvider`.
 */
@Injectable()
export class FcmPushProvider implements PushProvider {
  readonly name = 'fcm';
  private readonly logger = new Logger('PushProvider:fcm');
  private readonly app: admin.app.App;

  constructor(config: FcmProviderConfig) {
    // Use a named app so multiple Nest instances in the same process
    // (e.g. e2e tests) don't collide on the implicit default app.
    const existing = admin.apps.find((a) => a?.name === 'tarmoto-fcm');
    this.app =
      existing ??
      admin.initializeApp(
        {
          credential: admin.credential.cert({
            projectId: config.projectId,
            clientEmail: config.clientEmail,
            privateKey: config.privateKey,
          }),
        },
        'tarmoto-fcm',
      );
  }

  async send(
    targets: PushTarget[],
    payload: PushPayload,
  ): Promise<PushSendResult> {
    const tokens = targets.map((t) => t.token);
    if (tokens.length === 0) {
      return { delivered: 0, invalidTokens: [], providerName: this.name };
    }

    let response: admin.messaging.BatchResponse;
    try {
      response = await admin.messaging(this.app).sendEachForMulticast({
        tokens,
        notification: {
          title: payload.title,
          body: payload.body,
        },
        data: payload.data ?? {},
        // `collapse_key` makes successive same-category alerts
        // overwrite each other in the system tray rather than
        // stacking — useful for hazard alerts where the latest
        // observation replaces the prior one.
        android: payload.category
          ? { collapseKey: payload.category }
          : undefined,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `FCM batch failed (count=${tokens.length} category=${payload.category ?? 'none'}): ${reason}`,
      );
      // Whole batch failed — we can't tell which tokens are dead vs.
      // a transient FCM outage. Return zero invalid; service caller
      // will see `delivered=0` and log a warning.
      return { delivered: 0, invalidTokens: [], providerName: this.name };
    }

    const invalidTokens: string[] = [];
    response.responses.forEach((resp, i) => {
      if (resp.success) return;
      const errCode = resp.error?.code;
      // FCM error codes that mean "this token will never accept
      // another payload" — see firebase-admin docs. Any other code
      // (server unavailable, quota exceeded) is transient and the
      // token stays valid.
      if (
        errCode === 'messaging/registration-token-not-registered' ||
        errCode === 'messaging/invalid-argument' ||
        errCode === 'messaging/invalid-registration-token'
      ) {
        const token = tokens[i];
        if (token) invalidTokens.push(token);
      }
    });

    if (response.failureCount > 0) {
      this.logger.warn(
        `FCM partial failure: success=${response.successCount} ` +
          `failure=${response.failureCount} invalid=${invalidTokens.length}`,
      );
    }

    return {
      delivered: response.successCount,
      invalidTokens,
      providerName: this.name,
    };
  }
}
