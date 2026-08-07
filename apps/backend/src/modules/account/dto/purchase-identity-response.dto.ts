import { ApiProperty } from '@nestjs/swagger';

/**
 * The opaque identifier the client passes to the purchase SDK — RevenueCat's
 * `app_user_id` today, and whatever a future native path hands the store as its
 * account token.
 *
 * Returned ONLY to the authenticated caller for their OWN account. It must never
 * appear in a public profile, a list endpoint, or another rider's response: its
 * whole purpose is to be unguessable, so that knowing a rider's public id buys an
 * attacker nothing. See open item (j) in
 * `docs/superpowers/specs/2026-08-06-mobile-iap-revenuecat-design.md`.
 */
export class PurchaseIdentityResponseDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Opaque per-rider token for the purchase SDK. Pass this as the store/provider app user id — never the Tarmoto user id.',
  })
  purchase_account_token!: string;
}
