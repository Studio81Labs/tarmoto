import { Injectable, Logger } from '@nestjs/common';
import {
  type PushPayload,
  type PushProvider,
  type PushSendResult,
  type PushTarget,
} from '../push-provider.js';

/**
 * Routes targets to the right per-platform transport. iOS tokens go
 * to APN, Android tokens go to FCM. A target whose platform has no
 * configured transport falls through to the supplied fallback (the
 * log provider in dev / when only one of the two is configured).
 *
 * Aggregates the per-platform results so the service sees one
 * `PushSendResult` regardless of how many transports were involved.
 */
@Injectable()
export class CompositePushProvider implements PushProvider {
  readonly name = 'composite';
  private readonly logger = new Logger('PushProvider:composite');

  constructor(
    private readonly options: {
      ios: PushProvider | null;
      android: PushProvider | null;
      fallback: PushProvider;
    },
  ) {}

  async send(
    targets: PushTarget[],
    payload: PushPayload,
  ): Promise<PushSendResult> {
    if (targets.length === 0) {
      return { delivered: 0, invalidTokens: [], providerName: this.name };
    }

    const iosTargets: PushTarget[] = [];
    const androidTargets: PushTarget[] = [];
    const orphanTargets: PushTarget[] = [];

    for (const target of targets) {
      if (target.platform === 'ios') {
        if (this.options.ios) iosTargets.push(target);
        else orphanTargets.push(target);
      } else if (target.platform === 'android') {
        if (this.options.android) androidTargets.push(target);
        else orphanTargets.push(target);
      } else {
        // Unknown platform — log and route through fallback so we
        // never silently drop a registered device. The cast to string
        // is purely for the template literal: TypeScript narrows the
        // discriminated union to `never` in the else branch, but at
        // runtime a stale schema row could still surface a value
        // outside the enum we control.
        this.logger.warn(
          `unknown device platform "${String(target.platform as unknown)}" — routing through fallback`,
        );
        orphanTargets.push(target);
      }
    }

    // Fan out per-platform in parallel; aggregate at the end.
    const [iosResult, androidResult, orphanResult] = await Promise.all([
      iosTargets.length && this.options.ios
        ? this.options.ios.send(iosTargets, payload)
        : zero(this.name),
      androidTargets.length && this.options.android
        ? this.options.android.send(androidTargets, payload)
        : zero(this.name),
      orphanTargets.length
        ? this.options.fallback.send(orphanTargets, payload)
        : zero(this.name),
    ]);

    return {
      delivered:
        iosResult.delivered + androidResult.delivered + orphanResult.delivered,
      invalidTokens: [
        ...iosResult.invalidTokens,
        ...androidResult.invalidTokens,
        ...orphanResult.invalidTokens,
      ],
      providerName: this.name,
    };
  }
}

function zero(providerName: string): PushSendResult {
  return { delivered: 0, invalidTokens: [], providerName };
}
