import { Injectable, Logger } from '@nestjs/common';
import {
  type PushPayload,
  type PushProvider,
  type PushSendResult,
  type PushTarget,
} from '../push-provider.js';

/**
 * Routes targets to the right transport, favouring FCM when configured
 * because the mobile app stores FCM tokens for both platforms (Firebase
 * messaging wraps APN under the hood and `messaging.getToken()` returns
 * an FCM registration token regardless of OS).
 *
 * Routing rules:
 *   - Android targets always go to FCM. If FCM isn't configured they
 *     fall back to the supplied `fallback` (log) provider.
 *   - iOS targets prefer FCM when configured — Firebase delivers to
 *     iOS via APN under the hood, and the only thing we have at hand
 *     is an FCM registration token. Falls back to the raw-APN
 *     provider when FCM isn't configured (the niche case where an
 *     operator is running APN without Firebase, which would also
 *     require the mobile client to register raw `apns-token`s instead
 *     of FCM tokens). Final fallback is the log provider.
 *
 * Earlier iterations of this routing sent iOS targets straight to the
 * APN provider (or log when APN was unconfigured). With Firebase as
 * the mobile transport, both flavours of that were broken: only-FCM
 * setups dropped iOS pushes silently, and both-configured setups sent
 * FCM tokens to APN which rejects them with `BadDeviceToken` and
 * triggers soft-deletion of every active iOS row on each dispatch.
 *
 * Aggregates the per-transport results so the service sees one
 * `PushSendResult` regardless of how many transports were involved.
 */
@Injectable()
export class CompositePushProvider implements PushProvider {
  readonly name = 'composite';
  private readonly logger = new Logger('PushProvider:composite');

  constructor(
    private readonly options: {
      fcm: PushProvider | null;
      apn: PushProvider | null;
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

    const fcmTargets: PushTarget[] = [];
    const apnTargets: PushTarget[] = [];
    const orphanTargets: PushTarget[] = [];

    for (const target of targets) {
      if (target.platform === 'android') {
        if (this.options.fcm) fcmTargets.push(target);
        else orphanTargets.push(target);
      } else if (target.platform === 'ios') {
        // Prefer FCM (Firebase proxies to APN); fall back to raw APN
        // only when FCM isn't configured. See the class docstring
        // for why this matters with Firebase-issued tokens.
        if (this.options.fcm) fcmTargets.push(target);
        else if (this.options.apn) apnTargets.push(target);
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

    // Fan out per-transport in parallel; aggregate at the end.
    const [fcmResult, apnResult, orphanResult] = await Promise.all([
      fcmTargets.length && this.options.fcm
        ? this.options.fcm.send(fcmTargets, payload)
        : zero(this.name),
      apnTargets.length && this.options.apn
        ? this.options.apn.send(apnTargets, payload)
        : zero(this.name),
      orphanTargets.length
        ? this.options.fallback.send(orphanTargets, payload)
        : zero(this.name),
    ]);

    return {
      delivered:
        fcmResult.delivered + apnResult.delivered + orphanResult.delivered,
      invalidTokens: [
        ...fcmResult.invalidTokens,
        ...apnResult.invalidTokens,
        ...orphanResult.invalidTokens,
      ],
      providerName: this.name,
    };
  }
}

function zero(providerName: string): PushSendResult {
  return { delivered: 0, invalidTokens: [], providerName };
}
