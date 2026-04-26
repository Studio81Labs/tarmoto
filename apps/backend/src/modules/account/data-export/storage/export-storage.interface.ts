import type { Readable } from 'node:stream';

export const EXPORT_STORAGE = Symbol('EXPORT_STORAGE');

export interface ExportStorage {
  write(key: string, body: Readable): Promise<{ byteSize: number }>;
  read(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
}
