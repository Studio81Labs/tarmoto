import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Injectable } from '@nestjs/common';
import type { ExportStorage } from './export-storage.interface.js';

@Injectable()
export class LocalExportStorage implements ExportStorage {
  constructor(private readonly baseDir: string) {}

  private resolveKey(key: string): string {
    const target = resolve(this.baseDir, key);
    const base = resolve(this.baseDir) + sep;
    if (!(target + sep).startsWith(base)) {
      throw new Error(`invalid storage key: ${key}`);
    }
    return target;
  }

  async write(key: string, body: Readable): Promise<{ byteSize: number }> {
    const target = this.resolveKey(key);
    await mkdir(dirname(target), { recursive: true });
    try {
      await pipeline(body, createWriteStream(target));
    } catch (err) {
      // pipeline failed mid-write: a partial file containing personal
      // data may now sit on disk. Best-effort delete; the unlink is
      // wrapped in catch so an unrelated error here doesn't mask the
      // original write failure we're rethrowing.
      await unlink(target).catch(() => {});
      throw err;
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
}
