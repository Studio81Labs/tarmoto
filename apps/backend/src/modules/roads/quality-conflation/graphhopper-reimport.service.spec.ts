import type { ConfigType } from '@nestjs/config';
import type { graphhopperReimportConfig } from './graphhopper-reimport.config.js';
import { GraphHopperReimportService } from './graphhopper-reimport.service.js';

type Config = ConfigType<typeof graphhopperReimportConfig>;

function makeService(config: Partial<Config>): GraphHopperReimportService {
  const full: Config = {
    webhookUrl: null,
    token: null,
    method: 'POST',
    ...config,
  };
  return new GraphHopperReimportService(full);
}

describe('GraphHopperReimportService', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('no-ops (no request) when the webhook is not configured', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock;
    const service = makeService({ webhookUrl: null });

    expect(service.configured).toBe(false);
    await expect(service.trigger()).resolves.toEqual({ triggered: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs the webhook with a bearer token when configured', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 202 });
    global.fetch = fetchMock;
    const service = makeService({
      webhookUrl: 'https://ops.example.com/reimport',
      token: 'secret-token',
      method: 'POST',
    });

    expect(service.configured).toBe(true);
    await expect(service.trigger()).resolves.toEqual({ triggered: true });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://ops.example.com/reimport');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer secret-token',
    );
  });

  it('supports GET (e.g. Coolify deploy hooks) and omits auth when no token', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock;
    const service = makeService({
      webhookUrl: 'https://coolify.example.com/api/v1/deploy?uuid=abc',
      method: 'GET',
    });

    await service.trigger();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('GET');
    expect(init.headers as Record<string, string>).not.toHaveProperty(
      'Authorization',
    );
  });

  it('throws on a non-2xx response so the job fails visibly', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 503, statusText: 'Unavailable' });
    global.fetch = fetchMock;
    const service = makeService({
      webhookUrl: 'https://ops.example.com/reimport',
    });

    await expect(service.trigger()).rejects.toThrow(/503/);
  });

  it('throws (not swallow) on a connection failure', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    global.fetch = fetchMock;
    const service = makeService({
      webhookUrl: 'https://ops.example.com/reimport',
    });

    await expect(service.trigger()).rejects.toThrow(/failed to connect/);
  });

  it('does not leak the query string (token/uuid) into the thrown message', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 500, statusText: 'Error' });
    global.fetch = fetchMock;
    const service = makeService({
      webhookUrl: 'https://coolify.example.com/api/v1/deploy?uuid=SECRET',
      method: 'GET',
    });

    await expect(service.trigger()).rejects.toThrow(/deploy\?…/);
    await expect(service.trigger()).rejects.not.toThrow(/SECRET/);
  });
});
