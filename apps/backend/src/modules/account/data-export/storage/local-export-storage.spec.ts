import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { LocalExportStorage } from './local-export-storage.js';

describe('LocalExportStorage', () => {
  let dir: string;
  let storage: LocalExportStorage;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tarmoto-export-test-'));
    storage = new LocalExportStorage(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a stream and returns its byte size', async () => {
    const body = Readable.from(Buffer.from('hello world'));
    const result = await storage.write('foo/bar.zip', body);
    expect(result.byteSize).toBe(11);
    expect(statSync(join(dir, 'foo/bar.zip')).size).toBe(11);
  });

  it('reads back the same bytes', async () => {
    await storage.write('a.zip', Readable.from(Buffer.from('abc')));
    const reader = await storage.read('a.zip');
    const chunks: Buffer[] = [];
    for await (const c of reader) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('abc');
  });

  it('deletes a written file', async () => {
    await storage.write('a.zip', Readable.from(Buffer.from('abc')));
    await storage.delete('a.zip');
    await expect(storage.read('a.zip')).rejects.toThrow();
  });

  it('rejects keys that escape the base dir', async () => {
    await expect(
      storage.write('../escape.zip', Readable.from(Buffer.from('x'))),
    ).rejects.toThrow(/invalid storage key/i);
  });

  it('delete is a no-op when the key does not exist', async () => {
    await expect(storage.delete('does-not-exist.zip')).resolves.toBeUndefined();
  });

  it('exists returns true for written keys and false otherwise', async () => {
    await storage.write('a.zip', Readable.from(Buffer.from('abc')));
    await expect(storage.exists('a.zip')).resolves.toBe(true);
    await expect(storage.exists('missing.zip')).resolves.toBe(false);
  });
});
