import type { DataSource } from 'typeorm';
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
  // Advisory lock acquired by default; track lock/unlock + release.
  const managerQuery = jest.fn().mockResolvedValue([{ locked: true }]); // pg_try_advisory_lock / unlock
  const runner = {
    connect: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    manager: { query: managerQuery },
  };
  const dataSource = {
    createQueryRunner: jest.fn(() => runner),
  };
  const service = new NapService(
    client as unknown as NapClientService,
    parser as unknown as Datex2ParserService,
    reconcile as unknown as NapReconcileService,
    dataSource as unknown as DataSource,
    config,
  );
  return { service, client, parser, reconcile, managerQuery, runner };
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

  it('holds the advisory lock across the whole cycle and releases it', async () => {
    const { service, managerQuery, runner } = build();
    await service.poll();
    // Lock acquired before fetch; unlocked after; connection released.
    const sql = managerQuery.mock.calls as string[][];
    expect(sql[0]![0]).toContain('pg_try_advisory_lock');
    expect(sql[1]![0]).toContain('pg_advisory_unlock');
    expect(runner.release).toHaveBeenCalledTimes(1);
  });

  it('skips (returns null) without fetching when the lock is held by another worker', async () => {
    const { service, client, reconcile, managerQuery, runner } = build();
    managerQuery.mockResolvedValueOnce([{ locked: false }]);
    await expect(service.poll()).resolves.toBeNull();
    expect(client.fetchSnapshot).not.toHaveBeenCalled();
    expect(reconcile.reconcile).not.toHaveBeenCalled();
    expect(runner.release).toHaveBeenCalledTimes(1); // still cleaned up
  });
});
