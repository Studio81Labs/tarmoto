import { ValidationPipe } from '@nestjs/common';
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
import { createSwaggerConfig } from './config/swagger.config.js';
import { loadTrustProxyConfig } from './config/trust-proxy.config.js';
import { MAX_TRIP_SNAPSHOT_BYTES } from './modules/trip-shares/dto/trip-share.dto.js';
import { MAX_MAP_SNAPSHOT_BYTES } from './modules/map-shares/dto/map-share.dto.js';
import { IMPORT_TRIP_BODY_LIMIT_BYTES } from './modules/trips/dto/import-trip.dto.js';

// Default JSON body limit, matching body-parser's built-in default. Every
// endpoint except trip-share creation stays on this limit so we don't widen
// the memory-pressure attack surface beyond what's actually needed.
const DEFAULT_JSON_BODY_LIMIT = '100kb';

async function bootstrap() {
  const isProd = process.env.TARMOTO_NODE_ENV === 'production';
  // Disable Nest's auto-registered body parser so we can scope the larger
  // JSON limit needed by trip-share snapshots to just that route prefix.
  // `rawBody` is reimplemented below via the `verify` callback — keeping
  // Stripe's webhook signature verification working without opening up the
  // global JSON limit.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });

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
  // POST /api/v1/trips/import carries a parsed GPX/KML payload that
  // commonly exceeds 100 kb — even modestly long Garmin/Komoot tracks
  // (5–10k points) blow past the default once normalised to JSON. The
  // route prefix is matched verbatim so the wider limit applies only
  // to the import endpoint; the rest of `/api/v1/trips` (list/create/
  // generate/etc.) stays on the default limit.
  app.use(
    '/api/v1/trips/import',
    expressJson({
      limit: IMPORT_TRIP_BODY_LIMIT_BYTES,
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
  app.setGlobalPrefix('api/v1');

  // Serve locally-stored uploads (avatars today; review photos next)
  // when the `local` storage driver is in use. The path prefix and
  // base directory mirror `LocalStorage` so a contributor running
  // with default env config gets working avatar fetches without
  // touching MinIO. When `TARMOTO_STORAGE_DRIVER=s3` clients fetch
  // directly from the bucket / CDN, so this route is effectively
  // unused — leaving it mounted is harmless.
  const storageDriver = (process.env.TARMOTO_STORAGE_DRIVER ?? 'local')
    .trim()
    .toLowerCase();
  if (storageDriver === 'local') {
    const localDir =
      process.env.TARMOTO_LOCAL_STORAGE_DIR?.trim() ||
      join(process.cwd(), 'uploads');
    const publicPath =
      (process.env.TARMOTO_LOCAL_STORAGE_PUBLIC_PATH ?? '/uploads')
        .trim()
        .replace(/\/+$/, '') || '/uploads';
    app.use(publicPath, serveStatic(localDir));
  }

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  if (!isProd) {
    const document = SwaggerModule.createDocument(app, createSwaggerConfig());
    SwaggerModule.setup('api/docs', app, document);
  }

  await app.listen(process.env.TARMOTO_PORT ?? 3000);
}

void bootstrap();
