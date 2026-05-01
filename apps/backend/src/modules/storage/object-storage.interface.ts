import type { Readable } from 'node:stream';

/**
 * Pluggable object-storage abstraction. Used by features that persist
 * user-uploaded binaries (avatars today; review photos and GDPR
 * exports next) so the backend can run as multiple replicas without
 * sticky uploads.
 *
 * Two providers ship with the backend:
 *
 *   - `LocalStorage` — writes to the local filesystem under
 *     `${TARMOTO_LOCAL_STORAGE_DIR}` and exposes objects via the
 *     `/uploads` static route. Default for dev so contributors don't
 *     need MinIO running.
 *   - `S3Storage` — talks to any S3-compatible endpoint (AWS S3,
 *     Cloudflare R2, MinIO). Selected when
 *     `TARMOTO_STORAGE_DRIVER=s3`.
 *
 * Keys are caller-chosen, slash-delimited paths (e.g.
 * `avatars/<filename>`). Each provider validates the key against
 * path-traversal before touching storage; passing untrusted input as
 * a key is still unsafe — generate keys server-side from a UUID.
 */
export interface ObjectStorage {
  /**
   * Upload an object. `body` may be a Buffer (small uploads like
   * avatars / review photos) or a Readable stream (large uploads
   * like GDPR export ZIPs).
   *
   * Returns the byte size actually written so callers can record it
   * alongside the URL without re-stat'ing the destination.
   */
  put(args: PutArgs): Promise<PutResult>;

  /**
   * Open an object as a stream. Used by the API when serving a
   * private object through an authenticated route (e.g. the GDPR
   * export download path). For public objects clients should fetch
   * `publicUrl()` directly.
   */
  read(key: string): Promise<Readable>;

  /**
   * Best-effort delete. No-op when the key does not exist so callers
   * can use this for "remove the previous avatar" without racing
   * against the upload that just replaced it.
   */
  delete(key: string): Promise<void>;

  /** True iff the key exists. */
  exists(key: string): Promise<boolean>;

  /**
   * The URL the storage backend natively exposes for this object.
   *
   * - `LocalStorage` returns a server-relative path like
   *   `/uploads/avatars/<filename>`. Callers that need an absolute
   *   URL (e.g. to embed in a DB column the mobile client will
   *   pass to `<Image source>`) prepend their public base URL —
   *   the storage doesn't know what host it's reachable on.
   * - `S3Storage` returns an absolute URL based on the configured
   *   public URL base (CDN domain, R2 custom domain, or the bucket's
   *   default public URL).
   *
   * Buckets that are not publicly readable should serve via
   * `signedUrl()` instead.
   */
  publicUrl(key: string): string;

  /**
   * Time-bound URL for fetching a private object. For backends that
   * don't sign URLs (`LocalStorage`) this returns the same value as
   * `publicUrl()` — local dev is always direct-access.
   */
  signedUrl(key: string, ttlSeconds: number): Promise<string>;
}

export type PutArgs = {
  /**
   * Slash-delimited storage key, e.g. `avatars/<userId>-<uuid>.png`.
   * Validated by the provider against path-traversal.
   */
  key: string;
  body: Buffer | Readable;
  contentType?: string;
};

export type PutResult = {
  byteSize: number;
};
