import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type {
  ObjectStorage,
  PutArgs,
  PutResult,
} from './object-storage.interface.js';
import { validateStorageKey } from './validate-storage-key.js';

/**
 * Filesystem provider for the `ObjectStorage` interface. Used for
 * dev (no env config required) and as a fallback for single-instance
 * deploys. URLs are server-relative (`/uploads/...`) so they remain
 * valid when the API host changes.
 *
 * Keys must be POSIX-style paths inside `baseDir`; absolute paths,
 * traversal segments (`..`), control characters, and Windows
 * separators are rejected.
 */
export class LocalStorage implements ObjectStorage {
  constructor(
    private readonly baseDir: string,
    private readonly publicPathPrefix: string,
  ) {}

  async put(args: PutArgs): Promise<PutResult> {
    const target = this.resolveKey(args.key);
    await mkdir(dirname(target), { recursive: true });

    if (Buffer.isBuffer(args.body)) {
      await writeFile(target, args.body);
      return { byteSize: args.body.byteLength };
    }

    try {
      await pipeline(args.body, createWriteStream(target));
    } catch (error) {
      // Stream failed mid-write: a partial file may sit on disk.
      // Best-effort delete; the unlink is wrapped in catch so an
      // unrelated error doesn't mask the original write failure
      // we're rethrowing.
      await unlink(target).catch(() => {});
      throw error;
    }
    const s = await stat(target);
    return { byteSize: s.size };
  }

  async read(key: string): Promise<Readable> {
    const target = this.resolveKey(key);
    await stat(target);
    return createReadStream(target);
  }

  async delete(key: string): Promise<void> {
    const target = this.resolveKey(key);
    await unlink(target).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolveKey(key));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  publicUrl(key: string): string {
    validateStorageKey(key);
    const encoded = key
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    return `${this.publicPathPrefix}/${encoded}`;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  signedUrl(key: string, _ttlSeconds: number): Promise<string> {
    return Promise.resolve(this.publicUrl(key));
  }

  private resolveKey(key: string): string {
    validateStorageKey(key);
    const target = resolve(this.baseDir, key);
    const base = resolve(this.baseDir) + sep;
    if (!(target + sep).startsWith(base)) {
      throw new Error(`invalid storage key: ${key}`);
    }
    return target;
  }
}
