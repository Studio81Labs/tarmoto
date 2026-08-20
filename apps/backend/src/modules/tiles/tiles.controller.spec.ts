import { Test, TestingModule } from '@nestjs/testing';
import { AuthGuard } from '../auth/auth.guard.js';
import { OptionalAuthGuard } from '../auth/optional-auth.guard.js';
import { TilesController } from './tiles.controller.js';
import { TilesService } from './tiles.service.js';
import { TileTokenService } from './tile-token.service.js';

/** Minimal express req double: `user` set by OptionalAuthGuard (or absent). */
const anonReq = () => ({}) as never;
const authedReq = (userId: string) => ({ user: { userId } }) as never;

const mockRes = () =>
  ({
    set: jest.fn(),
    send: jest.fn(),
    status: jest.fn().mockReturnThis(),
    end: jest.fn(),
  }) as never;

type ResMock = {
  set: jest.Mock;
  send: jest.Mock;
  status: jest.Mock;
  end: jest.Mock;
};

describe('TilesController', () => {
  let controller: TilesController;
  let service: jest.Mocked<TilesService>;
  let tileTokens: jest.Mocked<TileTokenService>;

  beforeEach(async () => {
    const mockService = {
      getTile: jest.fn().mockResolvedValue(Buffer.from('mvt-data')),
    };
    const mockTileTokens = {
      issue: jest
        .fn()
        .mockResolvedValue({ token: 'minted-tile-token', expires_in: 900 }),
      // Default: nothing resolves — the anonymous baseline every pre-#1279
      // assertion below was written against.
      resolveUserId: jest.fn().mockResolvedValue(null),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TilesController],
      providers: [
        { provide: TilesService, useValue: mockService },
        { provide: TileTokenService, useValue: mockTileTokens },
      ],
    })
      // The real guards need JwtService + EntityManager; the unit tests
      // exercise the handlers directly and pass their own `req.user`, so the
      // guards are pass-throughs here (their own behavior is covered by the
      // reviews optional-auth path they were built for).
      .overrideGuard(OptionalAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<TilesController>(TilesController);
    service = module.get(TilesService);
    tileTokens = module.get(TileTokenService);
  });

  describe('GET /roads/tiles/:z/:x/:y.mvt', () => {
    it('should return MVT with correct headers', async () => {
      const res = mockRes();

      await controller.getTile({ z: 10, x: 550, y: 335 }, {}, anonReq(), res);

      expect(service.getTile).toHaveBeenCalledWith(10, 550, 335, 'all', null);
      expect((res as ResMock).set).toHaveBeenCalledWith(
        'Content-Type',
        'application/vnd.mapbox-vector-tile',
      );
      expect((res as ResMock).set).toHaveBeenCalledWith(
        'Cache-Control',
        'public, max-age=300',
      );
      expect((res as ResMock).set).toHaveBeenCalledWith(
        'CDN-Cache-Control',
        'public, max-age=900, stale-while-revalidate=86400',
      );
      expect((res as ResMock).send).toHaveBeenCalled();
    });

    it('should return 204 for empty tile', async () => {
      service.getTile.mockResolvedValueOnce(null);
      const res = mockRes();

      await controller.getTile({ z: 10, x: 550, y: 335 }, {}, anonReq(), res);

      expect((res as ResMock).status).toHaveBeenCalledWith(204);
      expect((res as ResMock).set).toHaveBeenCalledWith(
        'CDN-Cache-Control',
        'public, max-age=900, stale-while-revalidate=86400',
      );
      expect((res as ResMock).end).toHaveBeenCalled();
    });

    it('should pass layers query parameter', async () => {
      const res = mockRes();

      await controller.getTile(
        { z: 10, x: 550, y: 335 },
        { layers: 'quality' },
        anonReq(),
        res,
      );

      expect(service.getTile).toHaveBeenCalledWith(
        10,
        550,
        335,
        'quality',
        null,
      );
    });

    it('should not mark a tile-generation error as cacheable', async () => {
      service.getTile.mockRejectedValueOnce(new Error('PostGIS unavailable'));
      const res = mockRes();

      await expect(
        controller.getTile({ z: 10, x: 550, y: 335 }, {}, anonReq(), res),
      ).rejects.toThrow('PostGIS unavailable');

      expect((res as ResMock).set).not.toHaveBeenCalledWith(
        'Cache-Control',
        expect.anything(),
      );
      expect((res as ResMock).set).not.toHaveBeenCalledWith(
        'CDN-Cache-Control',
        expect.anything(),
      );
    });

    // #1108: since tile bytes can differ by requester entitlement, an
    // authenticated response must never enter a shared cache keyed only by
    // URL — a pro rider's above-cap quality tile served to an anonymous URL
    // hit would be an entitlement leak.
    describe('requester-dependent caching (#1108)', () => {
      it('passes the authenticated userId through to the service', async () => {
        const res = mockRes();

        await controller.getTile(
          { z: 14, x: 8800, y: 5360 },
          { layers: 'quality' },
          authedReq('user-pro'),
          res,
        );

        expect(service.getTile).toHaveBeenCalledWith(
          14,
          8800,
          5360,
          'quality',
          'user-pro',
        );
      });

      it('marks authenticated responses private with no CDN caching', async () => {
        const res = mockRes();

        await controller.getTile(
          { z: 14, x: 8800, y: 5360 },
          {},
          authedReq('user-pro'),
          res,
        );

        expect((res as ResMock).set).toHaveBeenCalledWith(
          'Cache-Control',
          'private, max-age=300',
        );
        expect((res as ResMock).set).not.toHaveBeenCalledWith(
          'CDN-Cache-Control',
          expect.anything(),
        );
      });

      it('keeps shared/CDN caching for anonymous responses', async () => {
        const res = mockRes();

        await controller.getTile(
          { z: 14, x: 8800, y: 5360 },
          {},
          anonReq(),
          res,
        );

        expect((res as ResMock).set).toHaveBeenCalledWith(
          'Cache-Control',
          'public, max-age=300',
        );
        expect((res as ResMock).set).toHaveBeenCalledWith(
          'CDN-Cache-Control',
          'public, max-age=900, stale-while-revalidate=86400',
        );
      });

      // #1279: the live MapLibre sources on both clients carry a scoped
      // `tile_token` query credential instead of the account bearer.
      describe('tile_token identity channel (#1279)', () => {
        it('resolves the rider from the token and passes it to the service', async () => {
          tileTokens.resolveUserId.mockResolvedValue('user-pro');
          const res = mockRes();

          await controller.getTile(
            { z: 14, x: 8800, y: 5360 },
            { layers: 'quality', tile_token: 'tt-abc' },
            anonReq(),
            res,
          );

          expect(tileTokens.resolveUserId).toHaveBeenCalledWith('tt-abc');
          expect(service.getTile).toHaveBeenCalledWith(
            14,
            8800,
            5360,
            'quality',
            'user-pro',
          );
        });

        it('marks a token-resolved response private, out of the shared cache', async () => {
          tileTokens.resolveUserId.mockResolvedValue('user-pro');
          const res = mockRes();

          await controller.getTile(
            { z: 14, x: 8800, y: 5360 },
            { tile_token: 'tt-abc' },
            anonReq(),
            res,
          );

          expect((res as ResMock).set).toHaveBeenCalledWith(
            'Cache-Control',
            'private, max-age=300',
          );
          expect((res as ResMock).set).not.toHaveBeenCalledWith(
            'CDN-Cache-Control',
            expect.anything(),
          );
        });

        it('serves an unresolvable token anonymously rather than failing', async () => {
          // A rotated-out or expired token must degrade the map to the free
          // view — MapLibre has no retry path for a failed tile.
          tileTokens.resolveUserId.mockResolvedValue(null);
          const res = mockRes();

          await controller.getTile(
            { z: 14, x: 8800, y: 5360 },
            { layers: 'quality', tile_token: 'tt-stale' },
            anonReq(),
            res,
          );

          expect(service.getTile).toHaveBeenCalledWith(
            14,
            8800,
            5360,
            'quality',
            null,
          );
          expect((res as ResMock).set).toHaveBeenCalledWith(
            'Cache-Control',
            'public, max-age=300',
          );
        });

        it('prefers a verified bearer over the query token', async () => {
          tileTokens.resolveUserId.mockResolvedValue('user-from-token');
          const res = mockRes();

          await controller.getTile(
            { z: 14, x: 8800, y: 5360 },
            { tile_token: 'tt-abc' },
            authedReq('user-from-bearer'),
            res,
          );

          expect(service.getTile).toHaveBeenCalledWith(
            14,
            8800,
            5360,
            'all',
            'user-from-bearer',
          );
          expect(tileTokens.resolveUserId).not.toHaveBeenCalled();
        });

        it('does not consult the token service when no token is supplied', async () => {
          const res = mockRes();

          await controller.getTile(
            { z: 14, x: 8800, y: 5360 },
            {},
            anonReq(),
            res,
          );

          expect(tileTokens.resolveUserId).toHaveBeenCalledWith(undefined);
          expect(service.getTile).toHaveBeenCalledWith(
            14,
            8800,
            5360,
            'all',
            null,
          );
        });
      });

      it('sets Vary: Authorization on tiles and on 204s alike', async () => {
        const res = mockRes();
        await controller.getTile(
          { z: 14, x: 8800, y: 5360 },
          {},
          anonReq(),
          res,
        );
        expect((res as ResMock).set).toHaveBeenCalledWith(
          'Vary',
          'Authorization',
        );

        service.getTile.mockResolvedValueOnce(null);
        const res204 = mockRes();
        await controller.getTile(
          { z: 14, x: 8800, y: 5360 },
          { layers: 'quality' },
          authedReq('user-free'),
          res204,
        );
        expect((res204 as ResMock).status).toHaveBeenCalledWith(204);
        expect((res204 as ResMock).set).toHaveBeenCalledWith(
          'Vary',
          'Authorization',
        );
        expect((res204 as ResMock).set).toHaveBeenCalledWith(
          'Cache-Control',
          'private, max-age=300',
        );
      });
    });
  });

  describe('POST /roads/tiles/token (#1279)', () => {
    it('mints a token for the authenticated caller', async () => {
      await expect(
        controller.mintToken(authedReq('user-pro')),
      ).resolves.toEqual({ token: 'minted-tile-token', expires_in: 900 });

      expect(tileTokens.issue).toHaveBeenCalledWith('user-pro');
    });
  });
});
