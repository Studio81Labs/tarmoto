import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { static as serveStatic } from 'express';
import { join } from 'node:path';
import { AppModule } from './app.module.js';
import { createSwaggerConfig } from './config/swagger.config.js';
import { loadTrustProxyConfig } from './config/trust-proxy.config.js';
import { MAX_TRIP_SNAPSHOT_BYTES } from './modules/trip-shares/dto/trip-share.dto.js';

async function bootstrap() {
  const isProd = process.env.TARMOTO_NODE_ENV === 'production';
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  // Express/body-parser defaults to 100 kb for JSON, which is below the
  // documented trip-shares snapshot cap (and realistic multi-day trips with
  // full route geometry). Raise the JSON body limit to leave headroom for the
  // DTO envelope (title + JSON punctuation) around the largest accepted
  // snapshot, so the 413 that a too-large request gets comes from our
  // validator's error message, not a generic Express rejection.
  app.useBodyParser('json', { limit: MAX_TRIP_SNAPSHOT_BYTES * 2 });

  const { hops } = loadTrustProxyConfig();
  if (hops > 0) {
    app.getHttpAdapter().getInstance().set('trust proxy', hops);
  }

  app.use(isProd ? helmet() : helmet({ contentSecurityPolicy: false }));
  app.setGlobalPrefix('api/v1');
  app.use('/uploads', serveStatic(join(process.cwd(), 'uploads')));

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
