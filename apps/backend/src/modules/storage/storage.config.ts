import { ConfigService } from '@nestjs/config';
import { join } from 'node:path';

export type StorageDriver = 'local' | 's3';

export interface LocalStorageConfig {
  driver: 'local';
  /**
   * Filesystem directory where the provider stores objects. Defaults
   * to `<cwd>/uploads` so first-time contributors get working avatar
   * uploads without env wiring.
   */
  baseDir: string;
  /**
   * URL path prefix that maps to `baseDir` via the static-file
   * middleware in `main.ts`. Defaults to `/uploads`. Stored URLs are
   * server-relative so the API can move hosts without invalidating
   * already-saved references.
   */
  publicPathPrefix: string;
}

export interface S3StorageConfig {
  driver: 's3';
  bucket: string;
  region: string;
  /**
   * Endpoint override for S3-compatible providers (Cloudflare R2,
   * MinIO). Leave undefined to use the default AWS endpoint for
   * `region`.
   */
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /**
   * Force path-style addressing (`https://endpoint/bucket/key`)
   * rather than virtual-hosted style. Required for MinIO and
   * convenient for R2; ignored by AWS S3 when virtual-hosted is
   * available.
   */
  forcePathStyle: boolean;
  /**
   * Public URL base for objects in this bucket. For R2 with a custom
   * domain this is the CDN URL; for AWS S3 with a public bucket it
   * is the bucket's website URL. When unset, `publicUrl()` falls
   * back to constructing a URL from the endpoint and bucket — this
   * works for MinIO out of the box but is rarely what production
   * deployments want.
   */
  publicUrlBase?: string;
}

export type StorageConfig = LocalStorageConfig | S3StorageConfig;

const DEFAULT_LOCAL_BASE_DIR = join(process.cwd(), 'uploads');
const DEFAULT_LOCAL_PUBLIC_PATH_PREFIX = '/uploads';

export function buildStorageConfig(config: ConfigService): StorageConfig {
  const driver = (config.get<string>('TARMOTO_STORAGE_DRIVER') ?? 'local')
    .trim()
    .toLowerCase();

  if (driver === 's3') {
    const bucket = required(config, 'TARMOTO_S3_BUCKET');
    const region = required(config, 'TARMOTO_S3_REGION');
    const accessKeyId = required(config, 'TARMOTO_S3_ACCESS_KEY_ID');
    const secretAccessKey = required(config, 'TARMOTO_S3_SECRET_ACCESS_KEY');
    const endpoint = config.get<string>('TARMOTO_S3_ENDPOINT')?.trim();
    const publicUrlBase = config
      .get<string>('TARMOTO_S3_PUBLIC_URL_BASE')
      ?.trim();
    const forcePathStyle =
      (config.get<string>('TARMOTO_S3_FORCE_PATH_STYLE') ?? 'false')
        .trim()
        .toLowerCase() === 'true';

    return {
      driver: 's3',
      bucket,
      region,
      endpoint: endpoint && endpoint.length > 0 ? endpoint : undefined,
      accessKeyId,
      secretAccessKey,
      forcePathStyle,
      publicUrlBase:
        publicUrlBase && publicUrlBase.length > 0
          ? publicUrlBase.replace(/\/+$/, '')
          : undefined,
    };
  }

  if (driver !== 'local') {
    throw new Error(
      `Unknown TARMOTO_STORAGE_DRIVER: ${driver}. Expected "local" or "s3".`,
    );
  }

  const baseDir =
    config.get<string>('TARMOTO_LOCAL_STORAGE_DIR')?.trim() ||
    DEFAULT_LOCAL_BASE_DIR;
  const publicPathPrefix = (
    config.get<string>('TARMOTO_LOCAL_STORAGE_PUBLIC_PATH') ??
    DEFAULT_LOCAL_PUBLIC_PATH_PREFIX
  ).trim();

  return {
    driver: 'local',
    baseDir,
    publicPathPrefix: publicPathPrefix.replace(/\/+$/, '') || '/uploads',
  };
}

function required(config: ConfigService, key: string): string {
  const value = config.get<string>(key)?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}
