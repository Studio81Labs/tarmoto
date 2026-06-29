import { NapService } from './nap.service.js';
import { NapClientService } from './nap-client.service.js';
import { Datex2ParserService } from './datex2-parser.service.js';
import { NapReconcileService } from './nap-reconcile.service.js';
import type { NapConfig } from './nap.config.js';
import type { NapReconcileResult } from './types/nap-situation.types.js';

const RESULT: NapReconcileResult = {
  parsed: 1,
  inserted: 1,
  updated: 0,
  deactivated: 0,
  needsDecoding: 0,
};

function build(over: Partial<NapConfig> = {}) {
  const config: NapConfig = {
    snapshotUrl: 'https://ndic.example/pull',
    username: '',
    password: '',
    clientCertPath: '',
    clientKeyPath: '',
    source: 'official',
    countryCode: 'CZ',
    pollEnabled: true,
    ...over,
  };
  const client = { fetchSnapshot: jest.fn().mockResolvedValue('<xml/>') };
  const parser = { parse: jest.fn().mockReturnValue([]) };
  const reconcile = { reconcile: jest.fn().mockResolvedValue(RESULT) };
  const service = new NapService(
    client as unknown as NapClientService,
    parser as unknown as Datex2ParserService,
    reconcile as unknown as NapReconcileService,
    config,
  );
  return { service, client, parser, reconcile };
}

describe('NapService.poll', () => {
  it('returns the reconcile result on success', async () => {
    const { service, reconcile } = build();
    await expect(service.poll()).resolves.toEqual(RESULT);
    expect(reconcile.reconcile).toHaveBeenCalledTimes(1);
  });

  it('skips (returns null) without fetching when polling is disabled', async () => {
    const { service, client } = build({ pollEnabled: false });
    await expect(service.poll()).resolves.toBeNull();
    expect(client.fetchSnapshot).not.toHaveBeenCalled();
  });

  it('rethrows when an enabled poll fails, so the BullMQ job fails', async () => {
    const { service, client } = build();
    client.fetchSnapshot.mockRejectedValueOnce(new Error('HTTP 401'));
    await expect(service.poll()).rejects.toThrow('HTTP 401');
  });

  it('resets the overlap guard after a failure (next poll can run)', async () => {
    const { service, client, reconcile } = build();
    client.fetchSnapshot.mockRejectedValueOnce(new Error('boom'));
    await expect(service.poll()).rejects.toThrow('boom');
    // running must have been cleared in `finally`, so the next tick runs.
    await expect(service.poll()).resolves.toEqual(RESULT);
    expect(reconcile.reconcile).toHaveBeenCalledTimes(1);
  });
});
