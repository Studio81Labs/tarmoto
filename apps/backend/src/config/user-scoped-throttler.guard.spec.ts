import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { UserScopedThrottlerGuard } from './user-scoped-throttler.guard.js';

describe('UserScopedThrottlerGuard', () => {
  let guard: UserScopedThrottlerGuard;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 5 }] }),
      ],
      providers: [UserScopedThrottlerGuard],
    }).compile();
    guard = module.get(UserScopedThrottlerGuard);
  });

  // The protected method is exercised here directly via a small adapter
  // — the production behaviour is covered by the controller spec; this
  // case just pins the keying contract that's the whole point of this
  // subclass: bucket by `(ip, user_id)` so users behind a shared IP
  // don't fight for the same throttle quota.
  function getTracker(req: Record<string, unknown>): Promise<string> {
    return (
      guard as unknown as {
        getTracker: (r: Record<string, unknown>) => Promise<string>;
      }
    ).getTracker(req);
  }

  it('keys by ip and user_id when both are present', async () => {
    expect(await getTracker({ ip: '1.2.3.4', user: { userId: 'u-1' } })).toBe(
      '1.2.3.4:u-1',
    );
  });

  it('keys two users on the same NAT to different buckets', async () => {
    const a = await getTracker({ ip: '1.2.3.4', user: { userId: 'u-1' } });
    const b = await getTracker({ ip: '1.2.3.4', user: { userId: 'u-2' } });
    expect(a).not.toBe(b);
  });

  it('falls back when user is unset (e.g. AuthGuard misconfigured)', async () => {
    expect(await getTracker({ ip: '1.2.3.4' })).toBe('1.2.3.4:anon');
  });

  it('falls back when ip is unset', async () => {
    expect(await getTracker({ user: { userId: 'u-1' } })).toBe(
      'unknown-ip:u-1',
    );
  });
});
