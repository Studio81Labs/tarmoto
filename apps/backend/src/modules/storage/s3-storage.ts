import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PassThrough, Readable } from 'node:stream';
import type {
  ObjectStorage,
  PutArgs,
  PutResult,
} from './object-storage.interface.js';
import type { S3StorageConfig } from './storage.config.js';
import { validateStorageKey } from './validate-storage-key.js';

/**
 * S3-compatible provider for the `ObjectStorage` interface. Selected
 * when `TARMOTO_STORAGE_DRIVER=s3`. Works against AWS S3, Cloudflare
 * R2, and MinIO — the differences are fully expressed via env vars
 * (endpoint, region, force-path-style, public URL base).
 *
 * Path-traversal validation is identical to `LocalStorage` so the
 * two providers reject the same set of bad keys; that matters for
 * tests that round-trip a key through both backends and for code
 * that builds keys from request input via a shared helper.
 */
export class S3Storage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicUrlBase: string;

  constructor(private readonly config: S3StorageConfig) {
    const clientConfig: S3ClientConfig = {
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: config.forcePathStyle,
    };
    if (config.endpoint) {
      clientConfig.endpoint = config.endpoint;
    }
    this.client = new S3Client(clientConfig);
    this.bucket = config.bucket;
    this.publicUrlBase = (
      config.publicUrlBase ?? this.fallbackPublicUrlBase()
    ).replace(/\/+$/, '');
  }

  async put(args: PutArgs): Promise<PutResult> {
    validateStorageKey(args.key);

    if (Buffer.isBuffer(args.body)) {
      // Small uploads (avatars / review photos) — single PUT is the
      // cheapest path, no multipart overhead.
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: args.key,
          Body: args.body,
          ContentType: args.contentType,
          ContentLength: args.body.byteLength,
        }),
      );
      return { byteSize: args.body.byteLength };
    }

    // Streaming upload (e.g. GDPR export ZIPs). `lib-storage`'s
    // `Upload` automatically switches to multipart for bodies above
    // its part size, so we don't have to buffer the entire archive
    // in memory. We tee the source through a `PassThrough` to count
    // bytes — the SDK doesn't surface the final size on its own.
    const counter = new PassThrough();
    let byteSize = 0;
    counter.on('data', (chunk: Buffer | string) => {
      byteSize += Buffer.isBuffer(chunk) ? chunk.byteLength : chunk.length;
    });
    args.body.on('error', (err) => counter.destroy(err));
    args.body.pipe(counter);

    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: args.key,
        Body: counter,
        ContentType: args.contentType,
      },
    });
    await upload.done();
    return { byteSize };
  }

  async read(key: string): Promise<Readable> {
    validateStorageKey(key);
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!result.Body) {
      throw new Error(`object not found: ${key}`);
    }
    return result.Body as Readable;
  }

  async delete(key: string): Promise<void> {
    validateStorageKey(key);
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async exists(key: string): Promise<boolean> {
    validateStorageKey(key);
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return true;
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } })
        .$metadata?.httpStatusCode;
      if (status === 404) return false;
      throw error;
    }
  }

  publicUrl(key: string): string {
    validateStorageKey(key);
    const encoded = key
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    return `${this.publicUrlBase}/${encoded}`;
  }

  async signedUrl(key: string, ttlSeconds: number): Promise<string> {
    validateStorageKey(key);
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: ttlSeconds },
    );
  }

  /**
   * Last-resort URL builder for buckets without a configured CDN /
   * custom-domain front. For MinIO (`forcePathStyle=true`) this
   * yields `${endpoint}/${bucket}/${key}`; for AWS S3 it yields the
   * standard virtual-hosted form. Production deployments should set
   * `TARMOTO_S3_PUBLIC_URL_BASE` instead of relying on this.
   */
  private fallbackPublicUrlBase(): string {
    const { bucket, endpoint, region, forcePathStyle } = this.config;
    if (endpoint) {
      const trimmed = endpoint.replace(/\/+$/, '');
      return forcePathStyle ? `${trimmed}/${bucket}` : trimmed;
    }
    return `https://${bucket}.s3.${region}.amazonaws.com`;
  }
}
