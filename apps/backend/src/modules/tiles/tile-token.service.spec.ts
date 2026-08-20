import { Test, TestingModule } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { getEntityManagerToken } from '@nestjs/typeorm';
import { User } from '../../entities/user.entity.js';
import {
  TileTokenService,
  TILE_TOKEN_EXPIRY_SECONDS,
} from './tile-token.service.js';

const SECRET = 'tile-token-spec-secret';
const RIDER = '11111111-1111-4111-8111-111111111111';

describe('TileTokenService (#1279)', () => {
  let service: TileTokenService;
  let jwt: JwtService;
  let findOne: jest.Mock;

  beforeEach(async () => {
    // A live account by default; individual tests override.
    findOne = jest.fn().mockResolvedValue({ id: RIDER, deleted_at: null });

    const module: TestingModule = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: SECRET,
          signOptions: { issuer: 'tarmoto' },
        }),
      ],
      providers: [
        TileTokenService,
        { provide: getEntityManagerToken(), useValue: { findOne } },
      ],
    }).compile();

    service = module.get(TileTokenService);
    jwt = module.get(JwtService);
  });

  describe('issue', () => {
    it('mints a token that resolves back to the rider', async () => {
      const { token, expires_in } = await service.issue(RIDER);

      expect(expires_in).toBe(TILE_TOKEN_EXPIRY_SECONDS);
      await expect(service.resolveUserId(token)).resolves.toBe(RIDER);
    });

    it('stamps the tile type and a short expiry, not an access token', async () => {
      const { token } = await service.issue(RIDER);
      const payload = jwt.verify<{
        sub: string;
        type: string;
        exp: number;
        iat: number;
      }>(token);

      // The `type` discriminator is the whole containment story: AuthGuard,
      // OptionalAuthGuard and UserScopedThrottlerGuard all require
      // `type === 'access'`, so this token opens no other door.
      expect(payload.type).toBe('tile');
      expect(payload.sub).toBe(RIDER);
      expect(payload.exp - payload.iat).toBe(TILE_TOKEN_EXPIRY_SECONDS);
    });
  });

  describe('resolveUserId', () => {
    it('returns null for an absent token without touching the database', async () => {
      await expect(service.resolveUserId(undefined)).resolves.toBeNull();
      await expect(service.resolveUserId('')).resolves.toBeNull();
      expect(findOne).not.toHaveBeenCalled();
    });

    it('returns null for a garbage token instead of throwing', async () => {
      // Load-bearing: a tile request is one of ~40 in a viewport with no
      // client retry path, so a bad credential must degrade the map to the
      // anonymous view rather than fail it.
      await expect(service.resolveUserId('not-a-jwt')).resolves.toBeNull();
      expect(findOne).not.toHaveBeenCalled();
    });

    it('returns null for a token signed with a different secret', async () => {
      const forged = new JwtService({ secret: 'someone-elses-secret' }).sign({
        sub: RIDER,
        type: 'tile',
      });

      await expect(service.resolveUserId(forged)).resolves.toBeNull();
      expect(findOne).not.toHaveBeenCalled();
    });

    it('returns null for an expired token', async () => {
      const expired = jwt.sign(
        { sub: RIDER, type: 'tile' },
        { expiresIn: '-1s' },
      );

      await expect(service.resolveUserId(expired)).resolves.toBeNull();
      expect(findOne).not.toHaveBeenCalled();
    });

    it.each(['access', 'refresh'])(
      'refuses a %s token presented as a tile token',
      async (type) => {
        // The reverse of the containment above: an access token in a URL query
        // string would be exactly the leak this design exists to prevent, so
        // the tile channel must not accept one.
        const wrongType = jwt.sign({ sub: RIDER, type });

        await expect(service.resolveUserId(wrongType)).resolves.toBeNull();
        expect(findOne).not.toHaveBeenCalled();
      },
    );

    it('returns null when the account has been soft-deleted', async () => {
      findOne.mockResolvedValue({ id: RIDER, deleted_at: new Date() });
      const { token } = await service.issue(RIDER);

      await expect(service.resolveUserId(token)).resolves.toBeNull();
    });

    it('returns null when the account row is gone', async () => {
      findOne.mockResolvedValue(null);
      const { token } = await service.issue(RIDER);

      await expect(service.resolveUserId(token)).resolves.toBeNull();
    });

    it('reads the account with the same narrow projection as OptionalAuthGuard', async () => {
      const { token } = await service.issue(RIDER);
      await service.resolveUserId(token);

      expect(findOne).toHaveBeenCalledWith(User, {
        where: { id: RIDER },
        select: { id: true, deleted_at: true },
      });
    });
  });
});
