import {
  ServiceUnavailableException,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SystemSwitchGuard } from './system-switch.guard.js';
import { RequireSystemSwitch } from './require-system-switch.decorator.js';

function makeContext(handler: object = {}) {
  return {
    getHandler: () => handler,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

function makeGuard(enabled: boolean) {
  const resolver = {
    isSystemSwitchEnabled: jest.fn().mockResolvedValue(enabled),
  };
  return {
    guard: new SystemSwitchGuard(new Reflector(), resolver as never),
    resolver,
  };
}

describe('SystemSwitchGuard', () => {
  const gated = (() => {
    class Dummy {
      @RequireSystemSwitch('sys_poi_ratings')
      handler() {}
    }
    // The reflected metadata is what the guard reads; the unbound
    // reference never runs, so `this` scoping is irrelevant here.

    return Dummy.prototype.handler;
  })();

  it('passes routes without a @RequireSystemSwitch declaration', async () => {
    const { guard, resolver } = makeGuard(false);
    await expect(guard.canActivate(makeContext())).resolves.toBe(true);
    // No declared switch → the resolver must not even be consulted.
    expect(resolver.isSystemSwitchEnabled).not.toHaveBeenCalled();
  });

  it('passes when the declared switch is on', async () => {
    const { guard, resolver } = makeGuard(true);
    await expect(guard.canActivate(makeContext(gated))).resolves.toBe(true);
    // The exact key must be forwarded — a key-swap between routes would
    // otherwise pass silently (resolveSystemSwitch ignores the key).
    expect(resolver.isSystemSwitchEnabled).toHaveBeenCalledWith(
      'sys_poi_ratings',
    );
  });

  it('throws 503 when the declared switch is off', async () => {
    const { guard, resolver } = makeGuard(false);
    await expect(guard.canActivate(makeContext(gated))).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(resolver.isSystemSwitchEnabled).toHaveBeenCalledWith(
      'sys_poi_ratings',
    );
  });

  it('does not read the request user (may run before AuthGuard)', async () => {
    // A system switch is global, so the guard resolves without touching the
    // request — makeContext exposes no `switchToHttp`, and this still works.
    const { guard } = makeGuard(true);
    await expect(guard.canActivate(makeContext(gated))).resolves.toBe(true);
  });
});
