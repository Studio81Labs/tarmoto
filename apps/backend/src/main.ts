// Must be the first import so Sentry can instrument the runtime before other
// modules load. No-op until TARMOTO_SENTRY_DSN is set (see instrument.ts).
import './instrument.js';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import {
  json as expressJson,
  static as serveStatic,
  urlencoded as expressUrlencoded,
  type Request,
  type Response,
} from 'express';
import { join } from 'node:path';
import { AppModule } from './app.module.js';
import { RedisIoAdapter } from './modules/events/redis-io.adapter.js';
import { redisConfig } from './config/redis.config.js';
import { createSwaggerConfig } from './config/swagger.config.js';
import {
  setupGlobalPrefix,
  stripAdminPathsGlobalPrefix,
} from './config/global-prefix.js';
import { loadTrustProxyConfig } from './config/trust-proxy.config.js';
import { guardClientSocketErrors } from './config/socket-error-guard.js';
import {
  IMPORT_TRIP_BODY_LIMIT_PATHS,
  ROUTE_GEOMETRY_BODY_LIMIT_PATHS,
} from './config/body-limits.js';
import { MAX_TRIP_SNAPSHOT_BYTES } from './modules/trip-shares/dto/trip-share.dto.js';
import { MAX_MAP_SNAPSHOT_BYTES } from './modules/map-shares/dto/map-share.dto.js';
import { IMPORT_TRIP_BODY_LIMIT_BYTES } from './modules/trips/dto/import-trip.dto.js';
import { ROUTE_QUALITY_BODY_LIMIT_BYTES } from './modules/roads/dto/route-quality.dto.js';

// Default JSON body limit, matching body-parser's built-in default. Every
// endpoint except trip-share creation stays on this limit so we don't widen
// the memory-pressure attack surface beyond what's actually needed.
const DEFAULT_JSON_BODY_LIMIT = '100kb';

async function bootstrap() {
  const isProd = process.env.NODE_ENV === 'production';
  // Disable Nest's auto-registered body parser so we can scope the larger
  // JSON limit needed by trip-share snapshots to just that route prefix.
  // `rawBody` is reimplemented below via the `verify` callback — keeping
  // Stripe's webhook signature verification working without opening up the
  // global JSON limit.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });

  // Use a custom IoAdapter so the socket.io Redis adapter is applied
  // before the server starts (NestJS v11 proxies the afterInit server
  // object and shadows server.adapter()).
  const redisAdapter = new RedisIoAdapter(app);
  app.useWebSocketAdapter(redisAdapter);

  // Connect to Redis (graceful: logs a warning and falls back to
  // in-memory pub/sub if Redis is unreachable).
  const redisCfg = redisConfig();
  try {
    await redisAdapter.connectRedis({
      host: redisCfg.host,
      port: redisCfg.port,
      ...(redisCfg.username !== undefined
        ? { username: redisCfg.username }
        : {}),
      ...(redisCfg.password !== undefined
        ? { password: redisCfg.password }
        : {}),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `Redis adapter not available (${msg}), falling back to in-memory pub/sub`,
    );
  }

  const captureRawBody = (
    req: Request & { rawBody?: Buffer },
    _res: Response,
    buf: Buffer,
  ): void => {
    if (buf?.length) req.rawBody = buf;
  };

  // POST /api/v1/trip-shares carries a full client-side trip snapshot which
  // can realistically exceed the 100 kb default (multi-day trip + per-day
  // route geometry). Accept up to 2× `MAX_TRIP_SNAPSHOT_BYTES` so the
  // envelope overhead still fits and the validator's
  // `SnapshotSizeConstraint` is what rejects oversized snapshots — not
  // body-parser's generic 413. Other endpoints stay on the default limit.
  app.use(
    '/api/v1/trip-shares',
    expressJson({
      limit: MAX_TRIP_SNAPSHOT_BYTES * 2,
      verify: captureRawBody,
    }),
  );
  // Same rationale as trip-shares — POST /api/v1/map-shares carries a
  // ridden-segments snapshot that easily exceeds the 100 kb default once
  // a rider has covered a few thousand segments. Cap matches the DTO's
  // `MAX_MAP_SNAPSHOT_BYTES` (×2 for envelope overhead) so the validator
  // is what rejects oversize payloads, not body-parser's generic 413.
  app.use(
    '/api/v1/map-shares',
    expressJson({
      limit: MAX_MAP_SNAPSHOT_BYTES * 2,
      verify: captureRawBody,
    }),
  );
  // GPX/KML import routes carry parsed payloads that commonly exceed
  // 100 kb — even modestly long Garmin/Komoot tracks (5–10k points)
  // blow past the default once normalised to JSON. The paths are
  // registered explicitly so the wider limit applies only to import
  // endpoints; the rest of `/api/v1/trips` stays on the default limit.
  app.use(
    IMPORT_TRIP_BODY_LIMIT_PATHS,
    expressJson({
      limit: IMPORT_TRIP_BODY_LIMIT_BYTES,
      verify: captureRawBody,
    }),
  );
  // POST /api/v1/roads/route-quality carries the full routed day/leg polyline,
  // which can run to a few thousand vertices — over the 100 kb default — while
  // still under the service's 500 km length cap. Scope it up so a valid
  // overlay request reaches the handler instead of body-parser's generic 413.
  app.use(
    '/api/v1/roads/route-quality',
    expressJson({
      limit: ROUTE_QUALITY_BODY_LIMIT_BYTES,
      verify: captureRawBody,
    }),
  );
  // The STOPS-tab corridor endpoints carry the same routed day/leg polyline as
  // route-quality — the OSM store (#859), pass and closure checks, and the
  // fun-zones corridor (#865). A dense route runs to a few thousand vertices,
  // over the 100 kb default, so scope them up too or body-parser 413s before
  // validation and the bounded spatial queries run.
  app.use(
    ROUTE_GEOMETRY_BODY_LIMIT_PATHS,
    expressJson({
      limit: ROUTE_QUALITY_BODY_LIMIT_BYTES,
      verify: captureRawBody,
    }),
  );
  app.use(
    expressJson({ limit: DEFAULT_JSON_BODY_LIMIT, verify: captureRawBody }),
  );
  app.use(
    expressUrlencoded({ extended: true, limit: DEFAULT_JSON_BODY_LIMIT }),
  );

  const { hops } = loadTrustProxyConfig();
  if (hops > 0) {
    app.getHttpAdapter().getInstance().set('trust proxy', hops);
  }

  app.use(isProd ? helmet() : helmet({ contentSecurityPolicy: false }));

  // CORS origins: env override (comma-separated) takes precedence,
  // then the hardcoded production list, then wide-open in dev.
  const corsOrigin = process.env.TARMOTO_CORS_ORIGIN
    ? process.env.TARMOTO_CORS_ORIGIN.split(',').map((s) => s.trim())
    : isProd
      ? ['https://app.tarmoto.app', 'https://tarmoto.app']
      : true;

  app.enableCors({
    origin: corsOrigin,
    credentials: true,
  });

  setupGlobalPrefix(app);

  // Serve locally-stored uploads (avatars, review photos). GDPR
  // data-export ZIPs share the same `LocalStorage` baseDir but are
  // never reached via this static route — `/account/data-export/:id/
  // download` always streams them through an HMAC-checked endpoint.
  // The path prefix and base directory mirror `LocalStorage` so a
  // contributor running with default env config gets working avatar
  // fetches without touching MinIO.
  //
  // The route stays mounted even when `TARMOTO_STORAGE_DRIVER=s3`:
  // new uploads go to the bucket, but already-stored avatar URLs
  // pointing at `/uploads/avatars/<file>` (from before the cutover,
  // or sitting in older mobile-app caches) keep resolving against
  // the existing local filesystem until the data backfill described
  // in the runbook completes. Gating this on the driver flag would
  // 404 every legacy URL the moment S3 is enabled.
  const localDir =
    process.env.TARMOTO_LOCAL_STORAGE_DIR?.trim() ||
    join(process.cwd(), 'uploads');
  const publicPath =
    (process.env.TARMOTO_LOCAL_STORAGE_PUBLIC_PATH ?? '/uploads')
      .trim()
      .replace(/\/+$/, '') || '/uploads';
  // Hard 404 for the GDPR `exports/` prefix BEFORE serve-static gets
  // a chance: those ZIPs are personal data and must only flow out via
  // the HMAC-checked `/account/data-export/:id/download` route. With
  // LocalStorage they live under the same baseDir as avatars, so
  // without this guard `/uploads/exports/<userId>/<requestId>.zip`
  // would hand the bundle to anyone who knew the two UUIDs.
  app.use(`${publicPath}/exports`, (_req: Request, res: Response) => {
    res.status(404).send('Not Found');
  });
  app.use(publicPath, serveStatic(localDir));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  if (!isProd) {
    const document = stripAdminPathsGlobalPrefix(
      SwaggerModule.createDocument(app, createSwaggerConfig()),
    );
    SwaggerModule.setup('api/docs', app, document);
  }

  // A client-side connection reset must never crash the API: attach a
  // socket `error` listener at accept time, before the HTTP/WebSocket layer
  // races to attach its own. See `guardClientSocketErrors`.
  guardClientSocketErrors(app.getHttpServer(), new Logger('Bootstrap'));

  await app.listen(process.env.PORT ?? 3000);

  // Gracefully disconnect Redis on shutdown.
  const shutdown = () => {
    void app.close().finally(() => redisAdapter.closeRedisClients());
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

void bootstrap();
