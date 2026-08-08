import { Logger } from '@nestjs/common';
import { BillingConfigCheck } from './billing-config.check.js';

describe('BillingConfigCheck', () => {
  const ALL = {
    TARMOTO_STRIPE_SECRET_KEY: 'sk_test_x',
    TARMOTO_STRIPE_WEBHOOK_SECRET: 'whsec_x',
    TARMOTO_STRIPE_PRO_PRICE_ID: 'price_pro',
    TARMOTO_STRIPE_PREMIUM_PRICE_ID: 'price_premium',
  };

  function run(env: Record<string, string | undefined>): {
    error: jest.SpyInstance;
    log: jest.SpyInstance;
  } {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const config = { get: (key: string) => env[key] } as never;
    new BillingConfigCheck(config).onModuleInit();
    return { error, log };
  }

  afterEach(() => jest.restoreAllMocks());

  it('says nothing when everything is configured', () => {
    const { error, log } = run(ALL);
    expect(error).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('reports billing OFF, not broken, when nothing is set', () => {
    // Every local dev environment and CI run looks like this. Erroring here
    // would make the signal worthless — operators would learn to ignore it,
    // and the partial case below is the one that matters.
    const { error, log } = run({});
    expect(error).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('NOT configured'));
  });

  it('ERRORS on a partial configuration — the deploy that takes money and grants nothing', () => {
    // Nobody sets a secret key and no price IDs on purpose. Checkout would
    // succeed and the webhook would map the price to no tier, so the rider pays
    // and is entitled nothing — silently, without this.
    const { error } = run({
      TARMOTO_STRIPE_SECRET_KEY: 'sk_test_x',
      TARMOTO_STRIPE_WEBHOOK_SECRET: 'whsec_x',
    });
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('PARTIALLY configured'),
    );
  });

  it('names exactly which variables are missing AND which are present', () => {
    // "Which half did I forget?" is the only question worth answering at 2am,
    // so the message has to answer it without a second deploy.
    const { error } = run({
      TARMOTO_STRIPE_SECRET_KEY: 'sk_test_x',
      TARMOTO_STRIPE_PRO_PRICE_ID: 'price_pro',
    });
    const message = String((error.mock.calls as Array<[unknown]>)[0]?.[0]);
    expect(message).toContain('TARMOTO_STRIPE_WEBHOOK_SECRET');
    expect(message).toContain('TARMOTO_STRIPE_PREMIUM_PRICE_ID');
    expect(message).toContain('TARMOTO_STRIPE_SECRET_KEY');
    expect(message).toContain('TARMOTO_STRIPE_PRO_PRICE_ID');
  });

  it('treats whitespace-only values as missing', () => {
    // A variable set to an empty string in a deploy UI is the common shape of
    // "I meant to fill this in", and it must not read as configured.
    const { error } = run({ ...ALL, TARMOTO_STRIPE_PREMIUM_PRICE_ID: '   ' });
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('TARMOTO_STRIPE_PREMIUM_PRICE_ID'),
    );
  });

  it('ERRORS when both paid tiers point at the SAME price', () => {
    // Presence is not coherence. Paste one price id into both fields — an
    // ordinary deploy-UI slip — and every required value is set, so a
    // presence-only check calls it healthy. A Premium purchase is then charged
    // at that price and granted PRO, because `tierFromPrice` matches the pro id
    // first. The rider overpays and nothing reports it.
    const { error } = run({
      ...ALL,
      TARMOTO_STRIPE_PREMIUM_PRICE_ID: ALL.TARMOTO_STRIPE_PRO_PRICE_ID,
    });
    const message = String((error.mock.calls as Array<[unknown]>)[0]?.[0]);
    expect(message).toContain('BOTH');
    expect(message).toContain(ALL.TARMOTO_STRIPE_PRO_PRICE_ID);
  });

  it('accepts two DIFFERENT paid prices', () => {
    const { error } = run(ALL);
    expect(error).not.toHaveBeenCalled();
  });

  it('ignores the OPTIONAL portal configuration id', () => {
    // Documented as optional (retention/cancellation deflection only), so its
    // absence is not evidence of a misconfiguration.
    const { error, log } = run(ALL);
    expect(error).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});
