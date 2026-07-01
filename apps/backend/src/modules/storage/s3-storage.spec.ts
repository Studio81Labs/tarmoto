/* eslint-disable
  @typescript-eslint/no-unsafe-return,
  @typescript-eslint/no-unsafe-member-access
*/
const sendMock = jest.fn();
const presignerMock = jest.fn();
const uploadDoneMock = jest.fn();
const uploadCtorMock = jest.fn();

jest.mock('@aws-sdk/client-s3', () => {
  return {
    S3Client: jest.fn().mockImplementation(() => ({ send: sendMock })),
    PutObjectCommand: jest.fn().mockImplementation((input: unknown) => ({
      _kind: 'PutObjectCommand',
      input,
    })),
    GetObjectCommand: jest.fn().mockImplementation((input: unknown) => ({
      _kind: 'GetObjectCommand',
      input,
    })),
    DeleteObjectCommand: jest.fn().mockImplementation((input: unknown) => ({
      _kind: 'DeleteObjectCommand',
      input,
    })),
    HeadObjectCommand: jest.fn().mockImplementation((input: unknown) => ({
      _kind: 'HeadObjectCommand',
      input,
    })),
  };
});

jest.mock('@aws-sdk/lib-storage', () => {
  return {
    Upload: jest
      .fn()
      .mockImplementation((args: { params: { Body: unknown } }) => {
        uploadCtorMock(args);
        // Real `lib-storage` drives the data flow by reading from
        // `params.Body`. The mock has to do the same — otherwise the
        // PassThrough wired up by `S3Storage.put()` never delivers
        // chunks and the byte counter stays at 0.
        return {
          done: async () => {
            const body = args.params.Body as NodeJS.ReadableStream;
            if (body && typeof body[Symbol.asyncIterator] === 'function') {
              for await (const _chunk of body) {
                // drain
              }
            }
            return uploadDoneMock();
          },
        };
      }),
  };
});

jest.mock('@aws-sdk/s3-request-presigner', () => {
  return { getSignedUrl: presignerMock };
});

import { Readable } from 'node:stream';
import { S3Storage } from './s3-storage.js';
import type { S3StorageConfig } from './storage.config.js';

const baseConfig: S3StorageConfig = {
  driver: 's3',
  bucket: 'tarmoto',
  region: 'us-east-1',
  endpoint: 'http://localhost:9000',
  accessKeyId: 'minioadmin',
  secretAccessKey: 'minioadmin',
  forcePathStyle: true,
  publicUrlBase: 'https://cdn.example.com',
};

describe('S3Storage', () => {
  beforeEach(() => {
    sendMock.mockReset();
    presignerMock.mockReset();
    uploadDoneMock.mockReset();
    uploadCtorMock.mockReset();
  });

  describe('put', () => {
    it('issues a PutObjectCommand for buffer bodies', async () => {
      sendMock.mockResolvedValueOnce({});
      const storage = new S3Storage(baseConfig);

      const result = await storage.put({
        key: 'avatars/foo.png',
        body: Buffer.from('hello'),
        contentType: 'image/png',
      });

      expect(result.byteSize).toBe(5);
      expect(sendMock).toHaveBeenCalledTimes(1);
      const call = sendMock.mock.calls[0][0] as {
        _kind: string;
        input: Record<string, unknown>;
      };
      expect(call._kind).toBe('PutObjectCommand');
      expect(call.input).toMatchObject({
        Bucket: 'tarmoto',
        Key: 'avatars/foo.png',
        ContentType: 'image/png',
        ContentLength: 5,
      });
    });

    it('uses the lib-storage Upload helper for stream bodies and returns the streamed byte count', async () => {
      uploadDoneMock.mockResolvedValueOnce({});
      const storage = new S3Storage(baseConfig);

      const result = await storage.put({
        key: 'exports/foo.zip',
        body: Readable.from([Buffer.from('abc'), Buffer.from('defg')]),
        contentType: 'application/zip',
      });

      // 'abc' (3) + 'defg' (4) = 7 bytes streamed through the
      // PassThrough counter.
      expect(result.byteSize).toBe(7);
      expect(uploadCtorMock).toHaveBeenCalledTimes(1);
      const ctorArg = uploadCtorMock.mock.calls[0][0] as {
        params: Record<string, unknown>;
      };
      expect(ctorArg.params).toMatchObject({
        Bucket: 'tarmoto',
        Key: 'exports/foo.zip',
        ContentType: 'application/zip',
      });
    });
  });

  describe('exists', () => {
    it('returns true on a 200 HEAD', async () => {
      sendMock.mockResolvedValueOnce({});
      const storage = new S3Storage(baseConfig);
      await expect(storage.exists('avatars/foo.png')).resolves.toBe(true);
    });

    it('returns false on a 404 HEAD', async () => {
      sendMock.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } });
      const storage = new S3Storage(baseConfig);
      await expect(storage.exists('avatars/foo.png')).resolves.toBe(false);
    });

    it('rethrows non-404 errors so transient failures surface', async () => {
      sendMock.mockRejectedValueOnce({
        $metadata: { httpStatusCode: 500 },
        message: 'internal',
      });
      const storage = new S3Storage(baseConfig);
      await expect(storage.exists('avatars/foo.png')).rejects.toMatchObject({
        $metadata: { httpStatusCode: 500 },
      });
    });
  });

  describe('publicUrl', () => {
    it('builds a URL under the configured publicUrlBase, encoding each segment', () => {
      const storage = new S3Storage(baseConfig);
      expect(storage.publicUrl('avatars/space file.png')).toBe(
        'https://cdn.example.com/avatars/space%20file.png',
      );
    });

    it('falls back to the path-style endpoint URL when no public base is set', () => {
      const storage = new S3Storage({
        ...baseConfig,
        publicUrlBase: undefined,
      });
      expect(storage.publicUrl('avatars/foo.png')).toBe(
        'http://localhost:9000/tarmoto/avatars/foo.png',
      );
    });

    it('falls back to the virtual-hosted AWS URL when no endpoint or public base is set', () => {
      const storage = new S3Storage({
        ...baseConfig,
        endpoint: undefined,
        forcePathStyle: false,
        publicUrlBase: undefined,
      });
      expect(storage.publicUrl('avatars/foo.png')).toBe(
        'https://tarmoto.s3.us-east-1.amazonaws.com/avatars/foo.png',
      );
    });
  });

  describe('signedUrl', () => {
    it('delegates to the presigner with the configured TTL', async () => {
      presignerMock.mockResolvedValueOnce(
        'https://cdn.example.com/avatars/foo.png?sig=abc',
      );
      const storage = new S3Storage(baseConfig);

      const url = await storage.signedUrl('avatars/foo.png', 600);

      expect(url).toBe('https://cdn.example.com/avatars/foo.png?sig=abc');
      expect(presignerMock).toHaveBeenCalledTimes(1);
      const [, command, options] = presignerMock.mock.calls[0] as unknown[];
      expect(command).toMatchObject({
        _kind: 'GetObjectCommand',
        input: { Bucket: 'tarmoto', Key: 'avatars/foo.png' },
      });
      expect(options).toEqual({ expiresIn: 600 });
    });
  });

  describe('path-traversal protection', () => {
    it('rejects keys with `..` segments before issuing any S3 call', async () => {
      const storage = new S3Storage(baseConfig);
      await expect(
        storage.put({
          key: 'avatars/../../etc/passwd',
          body: Buffer.from('x'),
        }),
      ).rejects.toThrow(/invalid storage key/i);
      expect(sendMock).not.toHaveBeenCalled();
    });

    it('rejects absolute keys', async () => {
      const storage = new S3Storage(baseConfig);
      await expect(
        storage.put({ key: '/etc/passwd', body: Buffer.from('x') }),
      ).rejects.toThrow(/invalid storage key/i);
      expect(sendMock).not.toHaveBeenCalled();
    });

    it('rejects keys with backslashes', async () => {
      const storage = new S3Storage(baseConfig);
      await expect(
        storage.put({ key: 'avatars\\foo.png', body: Buffer.from('x') }),
      ).rejects.toThrow(/invalid storage key/i);
      expect(sendMock).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('issues a DeleteObjectCommand', async () => {
      sendMock.mockResolvedValueOnce({});
      const storage = new S3Storage(baseConfig);

      await storage.delete('avatars/foo.png');

      const call = sendMock.mock.calls[0][0] as {
        _kind: string;
        input: Record<string, unknown>;
      };
      expect(call._kind).toBe('DeleteObjectCommand');
      expect(call.input).toEqual({
        Bucket: 'tarmoto',
        Key: 'avatars/foo.png',
      });
    });
  });
});
