import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { GlobalFeatureStates } from '@tarmoto/shared';
import { FeatureKillSwitchGuard } from './feature-kill-switch.guard.js';
import { RequireFeatureKillSwitch } from './require-feature-kill-switch.decorator.js';

function makeContext(handler: object = {}) {
  return {
    getHandler: () => handler,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

function makeGuard(globalStates: GlobalFeatureStates) {
  const resolver = {
    getGlobalStates: jest.fn().mockResolvedValue(globalStates),
  };
  return {
    guard: new FeatureKillSwitchGuard(new Reflector(), resolver as never),
    resolver,
  };
}

describe('FeatureKillSwitchGuard', () => {
  const gated = (() => {
    class Dummy {
      @RequireFeatureKillSwitch('community_access')
      handler() {}
    }
    // The reflected metadata is what the guard reads; the unbound
    // reference never runs, so `this` scoping is irrelevant here.

    return Dummy.prototype.handler;
  })();

  it('passes routes without a @RequireFeatureKillSwitch declaration', async () => {
    const { guard, resolver } = makeGuard({ community_access: 'force_off' });
    await expect(guard.canActivate(makeContext())).resolves.toBe(true);
    // No declared key → the flag map must not even be read.
    expect(resolver.getGlobalStates).not.toHaveBeenCalled();
  });

  it('passes when the declared switch has no global override (default ON)', async () => {
    const { guard, resolver } = makeGuard({});
    await expect(guard.canActivate(makeContext(gated))).resolves.toBe(true);
    expect(resolver.getGlobalStates).toHaveBeenCalled();
  });

  it('passes on force_on', async () => {
    const { guard } = makeGuard({ community_access: 'force_on' });
    await expect(guard.canActivate(makeContext(gated))).resolves.toBe(true);
  });

  it('throws the FeatureForbiddenDto envelope with scope global on force_off', async () => {
    const { guard } = makeGuard({ community_access: 'force_off' });
    const killed = await guard.canActivate(makeContext(gated)).then(
      () => {
        throw new Error('expected canActivate to reject');
      },
      (err: unknown) => err,
    );
    expect(killed).toBeInstanceOf(ForbiddenException);
    // The exact envelope FeatureGuard throws — machine-readable `feature`
    // plus the `scope` discriminator, always 'global' for a kill switch.
    expect((killed as ForbiddenException).getResponse()).toEqual({
      statusCode: 403,
      error: 'Forbidden',
      message: 'Feature unavailable: community_access',
      feature: 'community_access',
      scope: 'global',
    });
  });

  it('resolves by the DECLARED key — a kill of another flag does not block', async () => {
    // Keyed so a gate wired to the wrong flag fails this pair: killing an
    // unrelated free toggle must not block, killing the declared one must.
    const { guard } = makeGuard({ road_quality_overlay: 'force_off' });
    await expect(guard.canActivate(makeContext(gated))).resolves.toBe(true);
  });

  it('does not read the request user (works on anonymous routes)', async () => {
    // The switch is global, so the guard resolves without touching the
    // request — makeContext exposes no `switchToHttp`, and this still works.
    const { guard } = makeGuard({});
    await expect(guard.canActivate(makeContext(gated))).resolves.toBe(true);
  });
});
