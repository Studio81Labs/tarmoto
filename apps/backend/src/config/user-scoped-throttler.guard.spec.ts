import { Test, TestingModule } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { UserScopedThrottlerGuard } from './user-scoped-throttler.guard.js';

describe('UserScopedThrottlerGuard', () => {
  let guard: UserScopedThrottlerGuard;
  let jwt: JwtService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        JwtModule.register({ secret: 'test-secret' }),
        ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 5 }] }),
      ],
      providers: [UserScopedThrottlerGuard],
    }).compile();
    guard = module.get(UserScopedThrottlerGuard);
    jwt = module.get(JwtService);
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

  it('keys by ip and user_id from req.user when an upstream guard already set it', async () => {
    expect(await getTracker({ ip: '1.2.3.4', user: { userId: 'u-1' } })).toBe(
      '1.2.3.4:u-1',
    );
  });

  it('keys two users on the same NAT to different buckets', async () => {
    const a = await getTracker({ ip: '1.2.3.4', user: { userId: 'u-1' } });
    const b = await getTracker({ ip: '1.2.3.4', user: { userId: 'u-2' } });
    expect(a).not.toBe(b);
  });

  it('falls back when no auth context is available', async () => {
    expect(await getTracker({ ip: '1.2.3.4' })).toBe('1.2.3.4:anon');
  });

  it('falls back when ip is unset', async () => {
    expect(await getTracker({ user: { userId: 'u-1' } })).toBe(
      'unknown-ip:u-1',
    );
  });

  it('verifies the Authorization Bearer token to derive user_id when req.user is empty', async () => {
    // Global APP_GUARD runs BEFORE controller-level AuthGuard, so
    // req.user isn't set yet for normal authenticated requests. The
    // guard must verify the JWT inline to bucket by the same userId
    // AuthGuard would extract.
    const token = await jwt.signAsync({ sub: 'u-7', type: 'access' });
    expect(
      await getTracker({
        ip: '1.2.3.4',
        headers: { authorization: `Bearer ${token}` },
      }),
    ).toBe('1.2.3.4:u-7');
  });

  it('falls back to anon when the JWT fails to verify (wrong secret / expired)', async () => {
    const fake = await new JwtService({ secret: 'other-secret' }).signAsync({
      sub: 'u-attacker',
      type: 'access',
    });
    expect(
      await getTracker({
        ip: '1.2.3.4',
        headers: { authorization: `Bearer ${fake}` },
      }),
    ).toBe('1.2.3.4:anon');
  });

  it('rejects refresh tokens — only access tokens credit the user bucket', async () => {
    const refresh = await jwt.signAsync({ sub: 'u-7', type: 'refresh' });
    expect(
      await getTracker({
        ip: '1.2.3.4',
        headers: { authorization: `Bearer ${refresh}` },
      }),
    ).toBe('1.2.3.4:anon');
  });
});
