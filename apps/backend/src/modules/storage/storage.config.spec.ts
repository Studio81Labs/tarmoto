import { ConfigService } from '@nestjs/config';
import { join } from 'node:path';
import { buildStorageConfig } from './storage.config.js';

const fakeConfigService = (
  env: Record<string, string | undefined>,
): ConfigService =>
  ({
    get: <T>(key: string): T | undefined => env[key] as T | undefined,
  }) as unknown as ConfigService;

describe('buildStorageConfig', () => {
  describe('local driver', () => {
    it('defaults to local driver when no env is set', () => {
      const cfg = buildStorageConfig(fakeConfigService({}));
      expect(cfg).toEqual({
        driver: 'local',
        baseDir: join(process.cwd(), 'uploads'),
        publicPathPrefix: '/uploads',
      });
    });

    it('honours TARMOTO_LOCAL_STORAGE_DIR and TARMOTO_LOCAL_STORAGE_PUBLIC_PATH', () => {
      const cfg = buildStorageConfig(
        fakeConfigService({
          TARMOTO_LOCAL_STORAGE_DIR: '/srv/tarmoto/uploads',
          TARMOTO_LOCAL_STORAGE_PUBLIC_PATH: '/static',
        }),
      );
      expect(cfg).toEqual({
        driver: 'local',
        baseDir: '/srv/tarmoto/uploads',
        publicPathPrefix: '/static',
      });
    });

    it('strips trailing slashes from the public path prefix', () => {
      const cfg = buildStorageConfig(
        fakeConfigService({ TARMOTO_LOCAL_STORAGE_PUBLIC_PATH: '/uploads/' }),
      );
      expect(cfg).toMatchObject({ publicPathPrefix: '/uploads' });
    });
  });

  describe('s3 driver', () => {
    const validS3Env = {
      TARMOTO_STORAGE_DRIVER: 's3',
      TARMOTO_S3_BUCKET: 'tarmoto',
      TARMOTO_S3_REGION: 'eu-central-1',
      TARMOTO_S3_ACCESS_KEY_ID: 'AKIA...',
      TARMOTO_S3_SECRET_ACCESS_KEY: 'shhh',
    };

    it('builds a default config for AWS S3 (no endpoint, virtual-hosted)', () => {
      const cfg = buildStorageConfig(fakeConfigService(validS3Env));
      expect(cfg).toEqual({
        driver: 's3',
        bucket: 'tarmoto',
        region: 'eu-central-1',
        accessKeyId: 'AKIA...',
        secretAccessKey: 'shhh',
        forcePathStyle: false,
        endpoint: undefined,
        publicUrlBase: undefined,
      });
    });

    it('honours TARMOTO_S3_ENDPOINT for MinIO / R2', () => {
      const cfg = buildStorageConfig(
        fakeConfigService({
          ...validS3Env,
          TARMOTO_S3_ENDPOINT: 'http://localhost:9000',
          TARMOTO_S3_FORCE_PATH_STYLE: 'true',
        }),
      );
      expect(cfg).toMatchObject({
        endpoint: 'http://localhost:9000',
        forcePathStyle: true,
      });
    });

    it('strips trailing slashes from TARMOTO_S3_PUBLIC_URL_BASE', () => {
      const cfg = buildStorageConfig(
        fakeConfigService({
          ...validS3Env,
          TARMOTO_S3_PUBLIC_URL_BASE: 'https://cdn.example.com/',
        }),
      );
      expect(cfg).toMatchObject({
        publicUrlBase: 'https://cdn.example.com',
      });
    });

    it('throws a clear error when a required S3 env var is missing', () => {
      expect(() =>
        buildStorageConfig(
          fakeConfigService({
            TARMOTO_STORAGE_DRIVER: 's3',
            TARMOTO_S3_BUCKET: 'tarmoto',
            // missing region + creds
          }),
        ),
      ).toThrow(/TARMOTO_S3_REGION/);
    });
  });

  it('throws on an unknown driver instead of silently falling back', () => {
    expect(() =>
      buildStorageConfig(fakeConfigService({ TARMOTO_STORAGE_DRIVER: 'gcs' })),
    ).toThrow(/Unknown TARMOTO_STORAGE_DRIVER/);
  });
});
