import {
  Controller,
  Get,
  HttpStatus,
  type INestApplication,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Throttle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { Express } from 'express';
import request from 'supertest';
import type { App } from 'supertest/types';

/**
 * Verifies ThrottlerGuard buckets clients by their real IP (from the
 * `X-Forwarded-For` chain) when Express' `trust proxy` is configured — the
 * bug INFRA-181 guards against.
 *
 * Without `trust proxy`, every request behind the same upstream shares
 * `req.ip` = the proxy's IP, so two "different" clients collapse into one
 * throttle bucket. With `trust proxy` set to the correct hop count, Express
 * walks X-Forwarded-For from the right and returns the real client IP.
 */

const LIMIT = 2;
const TTL_MS = 60_000;

@Controller()
class ThrottledController {
  @Get('probe')
  @Throttle({ default: { ttl: TTL_MS, limit: LIMIT } })
  probe(): { ok: true } {
    return { ok: true };
  }
}

async function buildApp(trustProxyHops: number): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ThrottlerModule.forRoot({
        throttlers: [{ ttl: TTL_MS, limit: LIMIT }],
      }),
    ],
    controllers: [ThrottledController],
    providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
  }).compile();

  const app = moduleRef.createNestApplication();
  if (trustProxyHops > 0) {
    (app.getHttpAdapter().getInstance() as Express).set(
      'trust proxy',
      trustProxyHops,
    );
  }
  await app.init();
  return app;
}

async function hit(
  app: INestApplication,
  forwardedFor: string,
): Promise<number> {
  const res = await request(app.getHttpServer() as App)
    .get('/probe')
    .set('X-Forwarded-For', forwardedFor);
  return res.status;
}

describe('ThrottlerGuard × trust proxy (INFRA-181)', () => {
  describe('with trust proxy disabled (hops = 0)', () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await buildApp(0);
    });

    afterAll(async () => {
      await app.close();
    });

    it('collapses distinct X-Forwarded-For clients into one bucket', async () => {
      // Every request has a different spoofed XFF, but without trust proxy
      // Express ignores them — all requests share the loopback IP bucket.
      const statuses = [
        await hit(app, '10.0.0.1'),
        await hit(app, '10.0.0.2'),
        await hit(app, '10.0.0.3'),
      ];
      // 3 requests, limit is 2 → last one must be throttled despite
      // "coming from" three different IPs.
      expect(statuses).toEqual([
        HttpStatus.OK,
        HttpStatus.OK,
        HttpStatus.TOO_MANY_REQUESTS,
      ]);
    });
  });

  describe('with trust proxy = 1 (single upstream hop)', () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await buildApp(1);
    });

    afterAll(async () => {
      await app.close();
    });

    it('buckets per real client IP from X-Forwarded-For', async () => {
      // Three distinct clients each get their own bucket. None should be
      // throttled.
      expect(await hit(app, '10.0.0.1')).toBe(HttpStatus.OK);
      expect(await hit(app, '10.0.0.2')).toBe(HttpStatus.OK);
      expect(await hit(app, '10.0.0.3')).toBe(HttpStatus.OK);
    });

    it('throttles a single client that exceeds its own limit', async () => {
      const ip = '10.0.0.99';
      expect(await hit(app, ip)).toBe(HttpStatus.OK);
      expect(await hit(app, ip)).toBe(HttpStatus.OK);
      expect(await hit(app, ip)).toBe(HttpStatus.TOO_MANY_REQUESTS);
    });

    it('isolates a noisy client from other clients sharing the proxy', async () => {
      // Exhaust one client...
      const noisy = '10.0.1.1';
      await hit(app, noisy);
      await hit(app, noisy);
      expect(await hit(app, noisy)).toBe(HttpStatus.TOO_MANY_REQUESTS);

      // ...a different client behind the same proxy is unaffected.
      expect(await hit(app, '10.0.1.2')).toBe(HttpStatus.OK);
    });
  });
});
