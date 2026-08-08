import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Startup check for the Stripe billing configuration.
 *
 * ## The failure this exists to prevent
 *
 * Every Stripe setting is read lazily and degrades to a runtime
 * `ServiceUnavailableException('Billing is not configured')`. That is correct
 * behaviour and completely silent: a production deploy with an empty
 * `TARMOTO_STRIPE_SECRET_KEY` starts perfectly happily, and the first person to
 * discover billing is broken is a rider clicking Subscribe.
 *
 * ## Why it distinguishes "off" from "broken" rather than just requiring everything
 *
 * Billing genuinely is optional — every local dev environment and every CI run
 * has none of these set, and demanding them would break all of them. So the
 * check is on COHERENCE, not presence:
 *
 *  - **nothing set** → billing is deliberately off. Logged once at `log` level,
 *    because an operator should still be able to see it in the boot output.
 *  - **everything set** → nothing to say.
 *  - **partially set** → unambiguously a mistake. Nobody configures a secret key
 *    and no price IDs on purpose; that deploy takes money and grants nothing.
 *
 * ## Why it does not throw
 *
 * Refusing to boot would take down rides, hazards and safety alerts because a
 * price ID is missing — collateral damage far worse than a broken checkout. The
 * partial case logs at `error`, which is visible in the deploy output and in log
 * search, and pairs with the unmapped-price error in `AccountService` so the
 * silence is closed at both ends.
 *
 * `TARMOTO_STRIPE_PORTAL_CONFIGURATION_ID` is deliberately excluded — it is
 * documented as optional (only needed for retention/cancellation deflection),
 * so its absence is not evidence of anything.
 */
@Injectable()
export class BillingConfigCheck implements OnModuleInit {
  private readonly logger = new Logger(BillingConfigCheck.name);

  /** Everything required for a working checkout → webhook → entitlement loop. */
  private static readonly REQUIRED = [
    'TARMOTO_STRIPE_SECRET_KEY',
    'TARMOTO_STRIPE_WEBHOOK_SECRET',
    'TARMOTO_STRIPE_PRO_PRICE_ID',
    'TARMOTO_STRIPE_PREMIUM_PRICE_ID',
  ] as const;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const missing = BillingConfigCheck.REQUIRED.filter(
      (key) => !this.config.get<string>(key)?.trim(),
    );

    if (missing.length === 0) {
      this.checkPaidTiersAreDistinct();
      return;
    }

    if (missing.length === BillingConfigCheck.REQUIRED.length) {
      this.logger.log(
        'Stripe billing is NOT configured — checkout, the billing portal and ' +
          'subscription webhooks are disabled. Expected for local development ' +
          'and CI; set the TARMOTO_STRIPE_* variables to enable billing.',
      );
      return;
    }

    // Partial. Name what is missing AND what is present, because "which half did
    // I forget?" is the only question worth answering here.
    const present = BillingConfigCheck.REQUIRED.filter(
      (key) => !missing.includes(key),
    );
    this.logger.error(
      `Stripe billing is PARTIALLY configured — this deploy can take money and ` +
        `grant nothing. Missing: ${missing.join(', ')}. Present: ${present.join(', ')}. ` +
        `See docs/process/runbook.md ("Stripe billing go-live").`,
    );
    this.checkPaidTiersAreDistinct();
  }

  /**
   * The two paid tiers must not point at the SAME Stripe price.
   *
   * Presence is not coherence, and this is the shape that slips through it: paste
   * one price id into both variables — an ordinary copy-paste in a deploy UI —
   * and every required value is set, so the check above is satisfied.
   *
   * What then happens is silent and charges the wrong amount. A Premium checkout
   * uses that shared price, and `tierFromPrice` tests the PRO id first, so the
   * webhook grants `pro`. The rider pays the top price and receives the mid tier,
   * with nothing anywhere reporting a problem — the same failure as the 2026-07
   * tier swap, reached by a different mistake.
   */
  private checkPaidTiersAreDistinct(): void {
    const pro = this.config.get<string>('TARMOTO_STRIPE_PRO_PRICE_ID')?.trim();
    const premium = this.config
      .get<string>('TARMOTO_STRIPE_PREMIUM_PRICE_ID')
      ?.trim();
    if (!pro || !premium || pro !== premium) return;

    this.logger.error(
      `TARMOTO_STRIPE_PRO_PRICE_ID and TARMOTO_STRIPE_PREMIUM_PRICE_ID are BOTH ` +
        `set to ${pro} — a Premium purchase will be charged at that price and ` +
        `granted the PRO tier, because the pro id is matched first. Point them at ` +
        `the two different prices; see docs/process/runbook.md ` +
        `("Stripe billing go-live").`,
    );
  }
}
