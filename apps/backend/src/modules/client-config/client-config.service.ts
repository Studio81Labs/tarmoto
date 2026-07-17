import { Injectable } from '@nestjs/common';
import type {
  GlobalFeatureStates,
  GlobalLimitOverrides,
} from '@tarmoto/shared';
import { FeatureResolver } from '../features/feature-resolver.service.js';

@Injectable()
export class ClientConfigService {
  constructor(private readonly featureResolver: FeatureResolver) {}

  /**
   * Global feature overrides currently in force. Only overrides are
   * exposed publicly — per-user entitlements resolve on `/users/me`.
   * Clients use this for the kill-switch fast path (`force_off` wins over
   * a cached snapshot) and must not apply `force_on` from here alone.
   */
  featureStates(): Promise<GlobalFeatureStates> {
    return this.featureResolver.getGlobalStates();
  }

  /**
   * Global limit overrides currently in force (`null` = unlimited).
   * Clients may apply a value from this map only as a downward clamp
   * (min with the authenticated snapshot) — never to raise one.
   */
  limitOverrides(): Promise<GlobalLimitOverrides> {
    return this.featureResolver.getGlobalLimitOverrides();
  }
}
