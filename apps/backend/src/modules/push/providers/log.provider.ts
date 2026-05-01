import { Injectable, Logger } from '@nestjs/common';
import {
  type PushPayload,
  type PushProvider,
  type PushSendResult,
  type PushTarget,
} from '../push-provider.js';

/**
 * Dev / fallback transport. Writes the rendered push to the NestJS
 * logger so engineers can see what would have been sent without
 * provisioning Firebase or APN credentials. Also activated whenever
 * a real provider's required env vars are missing — keeps the rest
 * of the dispatch pipeline working in CI and local dev.
 */
@Injectable()
export class LogPushProvider implements PushProvider {
  readonly name = 'log';
  private readonly logger = new Logger('PushProvider:log');

  send(targets: PushTarget[], payload: PushPayload): Promise<PushSendResult> {
    if (targets.length === 0) {
      return Promise.resolve({
        delivered: 0,
        invalidTokens: [],
        providerName: this.name,
      });
    }
    const dataSuffix = payload.data
      ? ` data=${JSON.stringify(payload.data)}`
      : '';
    const categorySuffix = payload.category ? ` [${payload.category}]` : '';
    for (const target of targets) {
      this.logger.log(
        `→ ${target.platform}:${redactToken(target.token)}${categorySuffix} ` +
          `:: ${payload.title} — ${payload.body}${dataSuffix}`,
      );
    }
    return Promise.resolve({
      delivered: targets.length,
      invalidTokens: [],
      providerName: this.name,
    });
  }
}

/**
 * Tokens are reasonably long opaque strings (FCM ~152 chars, APN 64
 * hex chars). Truncate in logs so a misconfigured aggregator doesn't
 * end up indexing every push token in raw form — they're not as
 * sensitive as auth tokens but they're still user-tied identifiers
 * we don't need to replay verbatim into log searches.
 */
function redactToken(token: string): string {
  if (token.length <= 8) return '***';
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}
