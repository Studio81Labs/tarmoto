import { InternalServerErrorException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type * as express from 'express';
import { resolvePublicBaseUrl } from './public-base-url.js';

const fakeConfig = (env: Record<string, string | undefined>): ConfigService =>
  ({
    get: <T>(key: string): T | undefined => env[key] as T | undefined,
  }) as unknown as ConfigService;

const fakeReq = (host: string, protocol = 'https'): express.Request =>
  ({
    protocol,
    get: jest.fn().mockReturnValue(host),
  }) as unknown as express.Request;

describe('resolvePublicBaseUrl', () => {
  const originalNodeEnv = process.env.TARMOTO_NODE_ENV;

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.TARMOTO_NODE_ENV;
    else process.env.TARMOTO_NODE_ENV = originalNodeEnv;
  });

  it('falls back to the request-derived origin when TARMOTO_PUBLIC_BASE_URL is unset (dev)', () => {
    delete process.env.TARMOTO_NODE_ENV;
    const url = resolvePublicBaseUrl(
      fakeReq('api.tarmoto.test'),
      fakeConfig({}),
      { feature: 'Avatar uploads' },
    );
    expect(url).toBe('https://api.tarmoto.test');
  });

  it('prefers TARMOTO_PUBLIC_BASE_URL over the request-derived origin', () => {
    const url = resolvePublicBaseUrl(
      fakeReq('internal-pod.local'),
      fakeConfig({ TARMOTO_PUBLIC_BASE_URL: 'https://api.tarmoto.app' }),
      { feature: 'Avatar uploads' },
    );
    expect(url).toBe('https://api.tarmoto.app');
  });

  it('strips a single trailing slash from the configured base', () => {
    const url = resolvePublicBaseUrl(
      fakeReq('api.tarmoto.test'),
      fakeConfig({ TARMOTO_PUBLIC_BASE_URL: 'https://api.tarmoto.app/' }),
      { feature: 'Avatar uploads' },
    );
    expect(url).toBe('https://api.tarmoto.app');
  });

  it('throws in production when the env var is unset', () => {
    process.env.TARMOTO_NODE_ENV = 'production';
    expect(() =>
      resolvePublicBaseUrl(fakeReq('api.tarmoto.test'), fakeConfig({}), {
        feature: 'Avatar uploads',
      }),
    ).toThrow(InternalServerErrorException);
  });

  it('embeds the feature name in the production-error message', () => {
    process.env.TARMOTO_NODE_ENV = 'production';
    expect(() =>
      resolvePublicBaseUrl(fakeReq('api.tarmoto.test'), fakeConfig({}), {
        feature: 'Review photo uploads',
      }),
    ).toThrow(/Review photo uploads/);
  });

  it('lets requests through in production when the env var is set', () => {
    process.env.TARMOTO_NODE_ENV = 'production';
    const url = resolvePublicBaseUrl(
      fakeReq('internal-pod.local'),
      fakeConfig({ TARMOTO_PUBLIC_BASE_URL: 'https://api.tarmoto.app' }),
      { feature: 'Avatar uploads' },
    );
    expect(url).toBe('https://api.tarmoto.app');
  });
});
