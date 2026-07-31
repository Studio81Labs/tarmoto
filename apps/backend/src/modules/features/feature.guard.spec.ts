import {
  ForbiddenException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FeatureGuard } from './feature.guard.js';
import { RequireFeature } from './require-feature.decorator.js';

function makeContext(user?: { userId: string }, handler: object = {}) {
  return {
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  } as unknown as ExecutionContext;
}

function makeGuard(
  snapshot: Record<string, boolean>,
  globalStates: Record<string, string> = {},
) {
  const resolver = {
    resolveForUserWithStates: jest
      .fn()
      .mockResolvedValue({ snapshot, globalStates }),
  };
  return {
    guard: new FeatureGuard(new Reflector(), resolver as never),
    resolver,
  };
}

describe('FeatureGuard', () => {
  const gated = (() => {
    class Dummy {
      @RequireFeature('gpx_export')
      handler() {}
    }
    // The reflected metadata is what the guard reads; the unbound
    // reference never runs, so `this` scoping is irrelevant here.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    return Dummy.prototype.handler;
  })();

  it('passes routes without a @RequireFeature declaration', async () => {
    const { guard, resolver } = makeGuard({});
    await expect(
      guard.canActivate(makeContext({ userId: 'u1' })),
    ).resolves.toBe(true);
    expect(resolver.resolveForUserWithStates).not.toHaveBeenCalled();
  });

  it('passes when the user resolves the feature to true', async () => {
    const { guard, resolver } = makeGuard({ gpx_export: true });
    await expect(
      guard.canActivate(makeContext({ userId: 'u1' }, gated)),
    ).resolves.toBe(true);
    expect(resolver.resolveForUserWithStates).toHaveBeenCalledWith('u1');
  });

  it('throws 403 when the feature resolves to false', async () => {
    const { guard } = makeGuard({ gpx_export: false });
    await expect(
      guard.canActivate(makeContext({ userId: 'u1' }, gated)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('includes the machine-readable feature in the 403 envelope', async () => {
    const { guard } = makeGuard({ gpx_export: false });
    await expect(
      guard.canActivate(makeContext({ userId: 'u1' }, gated)),
    ).rejects.toMatchObject({
      response: {
        feature: 'gpx_export',
        message: 'Feature unavailable: gpx_export',
      },
    });
  });

  it("marks a global force_off block as scope 'global' (temporary)", async () => {
    // An operator kill switch: the client may retain + retry.
    const { guard } = makeGuard(
      { gpx_export: false },
      { gpx_export: 'force_off' },
    );
    await expect(
      guard.canActivate(makeContext({ userId: 'u1' }, gated)),
    ).rejects.toMatchObject({ response: { scope: 'global' } });
  });

  it("marks a per-user/tier block as scope 'user' (persistent)", async () => {
    // No global override — the block is a per-user override or tier denial,
    // which won't lift on its own, so the client must not silently retain.
    const { guard } = makeGuard({ gpx_export: false }, {});
    await expect(
      guard.canActivate(makeContext({ userId: 'u1' }, gated)),
    ).rejects.toMatchObject({ response: { scope: 'user' } });
  });

  it('throws 401 when placed without AuthGuard (no request user)', async () => {
    const { guard } = makeGuard({ gpx_export: true });
    await expect(
      guard.canActivate(makeContext(undefined, gated)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
