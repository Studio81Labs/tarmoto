import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DataSource } from 'typeorm';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppDataSource } from '../src/data-source.js';
import { DatabaseModule } from '../src/modules/database/database.module.js';
import { AuthModule } from '../src/modules/auth/index.js';
import { TilesModule } from '../src/modules/tiles/tiles.module.js';
import { setupGlobalPrefix } from '../src/config/global-prefix.js';

/**
 * Authenticated road-quality tiles + the anonymous zoom clamp (#1279, #1108)
 *
 * The `road_quality_max_zoom` tile clamp is the last client-trusted paid gate.
 * #1108 built the server-side backstop but its ANONYMOUS leg had to ship dark
 * behind `TARMOTO_TILES_ANON_QUALITY_ZOOM_CLAMP_ENABLED`, because no live
 * consumer sent identity — flipping it would have severed pro/premium deep
 * zoom. #1279 gives the clients two identity channels, and this spec is the
 * proof the env can now be flipped:
 *
 *   1. WITH THE ENV ON, an anonymous z13 quality tile carries no quality layer
 *      (`layers=quality` → 204), while the same tile at the free cap z12 is
 *      served in full — the acceptance criterion for the flip;
 *   2. a FREE rider carrying identity is clamped identically (identity is not
 *      a bypass, it is a resolution);
 *   3. a PRO rider keeps quality above z12 through BOTH channels — the
 *      `tile_token` query credential the live MapLibre sources carry, and the
 *      `Authorization` header the mobile offline-pack downloader sends;
 *   4. the token is genuinely tile-scoped: an ACCESS token presented as a
 *      `tile_token` resolves nothing, so the design cannot be short-circuited
 *      into putting an account bearer in a URL;
 *   5. a stale or forged credential DEGRADES to the anonymous view instead of
 *      failing the tile — MapLibre has no retry path, so a hard failure would
 *      blank the map rather than clamp it.
 *
 * Deliberately scoped to `DatabaseModule` + `AuthModule` + `TilesModule` (not
 * the full `AppModule`) so it needs ONLY a migrated PostgreSQL with PostGIS —
 * no Redis, no seed data — and can run in CI's real-postgres job against the
 * from-zero database.
 *
 * Local run prerequisites: `pnpm db:up && pnpm db:migrate` before
 * `pnpm --filter @tarmoto/backend test:e2e -- authed-quality-tiles`.
 */

const E2E_EMAIL = 'authed-quality-tiles-e2e@tarmoto.app';
const E2E_PASSWORD = 'e2e-password-123!';
const ANON_CLAMP_ENV = 'TARMOTO_TILES_ANON_QUALITY_ZOOM_CLAMP_ENABLED';

// A segment placed here is inside the z12, z13 and z18 tiles derived below, so
// one row proves every zoom in this spec. Somewhere quiet in central Bohemia.
const SEGMENT_LNG = 14.42;
const SEGMENT_LAT = 50.08;
const SEGMENT_MARKER = 'authed-quality-tiles-e2e';

/** Slippy-map tile containing a coordinate — the inverse of `tileToBBox`. */
function tileFor(z: number): { z: number; x: number; y: number } {
  const n = 2 ** z;
  const latRad = (SEGMENT_LAT * Math.PI) / 180;
  return {
    z,
    x: Math.floor(((SEGMENT_LNG + 180) / 360) * n),
    y: Math.floor(
      ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
        n,
    ),
  };
}

// The free `road_quality_max_zoom` is 12, so z12 is the last zoom a free/
// anonymous requester may see quality at and z13 is the first withheld one.
const AT_FREE_CAP = tileFor(12);
const ABOVE_FREE_CAP = tileFor(13);
const DEEP = tileFor(18);

describe('authenticated quality tiles + anonymous clamp (e2e, #1279)', () => {
  let app: INestApplication<App>;
  let seedDataSource: DataSource;
  let accessToken: string;
  let userId: string;
  let envBefore: string | undefined;

  const cleanup = async () => {
    // A crashed earlier run must never leave the database with a global
    // override that would silently un-clamp every later assertion.
    await seedDataSource.query(
      `DELETE FROM limit_states WHERE feature = 'road_quality_max_zoom'`,
    );
    await seedDataSource.query(
      `DELETE FROM road_segments WHERE road_name = $1`,
      [SEGMENT_MARKER],
    );
    await seedDataSource.query(`DELETE FROM users WHERE email = $1`, [
      E2E_EMAIL,
    ]);
  };

  const tilePath = (tile: { z: number; x: number; y: number }, query: string) =>
    `/api/v1/roads/tiles/${tile.z}/${tile.x}/${tile.y}.mvt?${query}`;

  /**
   * Tile GET with the protobuf body buffered. Without `responseType`,
   * superagent has no parser for `application/vnd.mapbox-vector-tile` and
   * leaves `res.body` an empty object — a byte assertion would then pass on a
   * clamped tile as readily as on a served one.
   */
  const getTile = (path: string) =>
    request(app.getHttpServer()).get(path).responseType('blob');

  const expectTileBytes = (res: { body: unknown }) => {
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect((res.body as Buffer).length).toBeGreaterThan(0);
  };

  const mintTileToken = async (bearer: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/roads/tiles/token')
      .set('Authorization', `Bearer ${bearer}`)
      .expect(200);
    const body = res.body as { token: string; expires_in: number };
    expect(body.expires_in).toBeGreaterThan(0);
    return body.token;
  };

  const setTier = async (tier: string) => {
    await seedDataSource.query(
      `UPDATE users SET subscription_tier = $1 WHERE id = $2`,
      [tier, userId],
    );
  };

  beforeAll(async () => {
    envBefore = process.env[ANON_CLAMP_ENV];
    // The whole point of the spec: prove the flip is safe, with it flipped.
    process.env[ANON_CLAMP_ENV] = 'true';

    seedDataSource = new DataSource(AppDataSource.options);
    await seedDataSource.initialize();
    await cleanup();

    // One scored segment inside every tile under test. `quality_score` is what
    // the quality layer selects on; `deactivated_at IS NULL` keeps it visible.
    await seedDataSource.query(
      `INSERT INTO road_segments (geom, length_m, quality_score, road_name, surface_type)
       VALUES (ST_SetSRID(ST_MakeLine(ST_MakePoint($1, $2), ST_MakePoint($3, $4)), 4326),
               400, 3.5, $5, 'asphalt')`,
      [
        SEGMENT_LNG - 0.002,
        SEGMENT_LAT,
        SEGMENT_LNG + 0.002,
        SEGMENT_LAT,
        SEGMENT_MARKER,
      ],
    );

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        DatabaseModule,
        AuthModule,
        TilesModule,
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    setupGlobalPrefix(app);
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    const register = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email: E2E_EMAIL,
        password: E2E_PASSWORD,
        display_name: 'Tile Probe',
      })
      .expect(201);
    accessToken = (register.body as { access_token: string }).access_token;

    const rows = await seedDataSource.query<{ id: string }[]>(
      `SELECT id FROM users WHERE email = $1`,
      [E2E_EMAIL],
    );
    userId = rows[0]!.id;
  }, 60_000);

  afterAll(async () => {
    if (seedDataSource?.isInitialized) {
      await cleanup();
    }
    await app?.close();
    if (seedDataSource?.isInitialized) {
      await seedDataSource.destroy();
    }
    if (envBefore === undefined) {
      delete process.env[ANON_CLAMP_ENV];
    } else {
      process.env[ANON_CLAMP_ENV] = envBefore;
    }
  }, 30_000);

  describe('anonymous requests with the clamp env ON', () => {
    it('serves the quality layer at the free cap (z12)', async () => {
      const res = await getTile(tilePath(AT_FREE_CAP, 'layers=quality')).expect(
        200,
      );

      expectTileBytes(res);
      expect(res.headers['content-type']).toContain(
        'application/vnd.mapbox-vector-tile',
      );
      // Anonymous bytes are identical for every anonymous requester, so they
      // stay CDN-cacheable — the property that lets the public map absorb its
      // 600/min bursts.
      expect(res.headers['cache-control']).toBe('public, max-age=300');
    });

    it('withholds the quality layer one zoom above the cap (z13)', async () => {
      await getTile(tilePath(ABOVE_FREE_CAP, 'layers=quality')).expect(204);
    });

    it('still serves the never-clamped surface layer above the cap', async () => {
      // Proof the 204 above is the CLAMP and not an empty tile: the same
      // coordinates carry data on a layer the clamp does not touch.
      const res = await getTile(
        tilePath(ABOVE_FREE_CAP, 'layers=surface'),
      ).expect(200);

      expectTileBytes(res);
    });
  });

  describe('a free rider carrying identity', () => {
    it('is clamped exactly like an anonymous one', async () => {
      const tileToken = await mintTileToken(accessToken);

      await getTile(
        tilePath(
          ABOVE_FREE_CAP,
          `layers=quality&tile_token=${encodeURIComponent(tileToken)}`,
        ),
      ).expect(204);

      await getTile(tilePath(ABOVE_FREE_CAP, 'layers=quality'))
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(204);
    });
  });

  describe('a premium rider', () => {
    beforeAll(async () => {
      await setTier('premium');
    });

    afterAll(async () => {
      await setTier('free');
    });

    it('keeps quality above z12 through both identity channels', async () => {
      // Pro and premium resolve `road_quality_max_zoom` to the same `null`, but
      // the acceptance names both tiers, so both are proven end to end rather
      // than inferred from the registry.
      const tileToken = await mintTileToken(accessToken);

      expectTileBytes(
        await getTile(
          tilePath(
            ABOVE_FREE_CAP,
            `layers=quality&tile_token=${encodeURIComponent(tileToken)}`,
          ),
        ).expect(200),
      );
      expectTileBytes(
        await getTile(tilePath(ABOVE_FREE_CAP, 'layers=quality'))
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(200),
      );
    });
  });

  describe('a pro rider', () => {
    beforeAll(async () => {
      await setTier('pro');
    });

    afterAll(async () => {
      await setTier('free');
    });

    it('keeps quality above z12 through the tile_token channel', async () => {
      const tileToken = await mintTileToken(accessToken);

      const res = await getTile(
        tilePath(
          ABOVE_FREE_CAP,
          `layers=quality&tile_token=${encodeURIComponent(tileToken)}`,
        ),
      ).expect(200);

      expectTileBytes(res);
      // Identity-bearing bytes must never enter a shared cache keyed by URL.
      expect(res.headers['cache-control']).toBe('private, max-age=300');
      expect(res.headers['cdn-cache-control']).toBeUndefined();
    });

    it('keeps quality above z12 through the Authorization channel (offline packs)', async () => {
      const res = await getTile(tilePath(ABOVE_FREE_CAP, 'layers=quality'))
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expectTileBytes(res);
      expect(res.headers['cache-control']).toBe('private, max-age=300');
    });

    it('is unlimited, not merely raised — quality still served at z18', async () => {
      const tileToken = await mintTileToken(accessToken);

      const res = await getTile(
        tilePath(
          DEEP,
          `layers=quality&tile_token=${encodeURIComponent(tileToken)}`,
        ),
      ).expect(200);

      expectTileBytes(res);
    });

    it('falls back to the anonymous view on a stale credential, never an error', async () => {
      // Rotation, sign-out and clock skew all land here. A 4xx would blank the
      // map; the clamp is the correct degrade.
      await getTile(
        tilePath(ABOVE_FREE_CAP, 'layers=quality&tile_token=not-a-jwt'),
      ).expect(204);

      await getTile(tilePath(ABOVE_FREE_CAP, 'layers=quality'))
        .set('Authorization', 'Bearer not-a-jwt')
        .expect(204);
    });

    it('refuses an access token presented as a tile_token', async () => {
      // The tile channel must not become a way to put an account bearer in a
      // URL: only `type: 'tile'` resolves.
      await getTile(
        tilePath(
          ABOVE_FREE_CAP,
          `layers=quality&tile_token=${encodeURIComponent(accessToken)}`,
        ),
      ).expect(204);
    });
  });

  describe('POST /roads/tiles/token', () => {
    it('requires authentication', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/roads/tiles/token')
        .expect(401);
    });
  });
});
