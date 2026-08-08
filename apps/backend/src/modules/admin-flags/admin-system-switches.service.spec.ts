import { BadRequestException } from '@nestjs/common';
import { SYSTEM_FEATURE_KEYS } from '@tarmoto/shared';
import { AdminSystemSwitchesService } from './admin-system-switches.service.js';

const NOW = new Date('2026-01-01T00:00:00Z');

interface FakeFeatureStateRow {
  feature: string;
  state: 'force_off' | 'force_on';
  reason: string | null;
  updated_by: string | null;
  updated_at: Date;
  created_at: Date;
}

/**
 * A tiny in-memory fake rather than a stateless stub: `disableSwitch` and
 * `enableSwitch` mutate the row and then re-read via `listSwitches`, so the
 * fake needs `find`/`findOne` to reflect prior `save`/`delete` calls for the
 * "returns the refreshed dto" behavior to be meaningfully testable.
 */
function makeService({ states = [] as FakeFeatureStateRow[] } = {}) {
  const rows: FakeFeatureStateRow[] = [...states];

  const featureStates = {
    find: jest.fn().mockImplementation(() => Promise.resolve([...rows])),
    findOne: jest
      .fn()
      .mockImplementation(
        ({ where: { feature } }: { where: { feature: string } }) =>
          Promise.resolve(rows.find((r) => r.feature === feature) ?? null),
      ),
    create: jest.fn().mockImplementation((v: Partial<FakeFeatureStateRow>) => ({
      created_at: NOW,
      updated_at: NOW,
      reason: null,
      updated_by: null,
      ...v,
    })),
    save: jest.fn().mockImplementation((row: FakeFeatureStateRow) => {
      const saved = { ...row, updated_at: NOW };
      const idx = rows.findIndex((r) => r.feature === saved.feature);
      if (idx === -1) rows.push(saved);
      else rows[idx] = saved;
      return Promise.resolve(saved);
    }),
    delete: jest.fn().mockImplementation(({ feature }: { feature: string }) => {
      const idx = rows.findIndex((r) => r.feature === feature);
      if (idx !== -1) rows.splice(idx, 1);
      return Promise.resolve({ affected: idx === -1 ? 0 : 1 });
    }),
  };
  return {
    svc: new AdminSystemSwitchesService(featureStates as never),
    featureStates,
  };
}

describe('AdminSystemSwitchesService', () => {
  it('listSwitches() returns every registry key, enabled, with no override', async () => {
    const { svc } = makeService();
    const { switches } = await svc.listSwitches();
    expect(switches.map((s) => s.key).sort()).toEqual(
      [...SYSTEM_FEATURE_KEYS].sort(),
    );
    expect(switches).toHaveLength(15);
    const weather = switches.find((s) => s.key === 'sys_weather_provider')!;
    expect(weather).toMatchObject({
      enabled: true,
      disabled_reason: null,
      disabled_by: null,
      disabled_at: null,
    });
  });

  it('listSwitches() folds in a seeded force_off row as disabled with reason/by/at', async () => {
    const { svc } = makeService({
      states: [
        {
          feature: 'sys_weather_provider',
          state: 'force_off',
          reason: 'provider outage',
          updated_by: 'a1',
          updated_at: NOW,
          created_at: NOW,
        },
      ],
    });
    const { switches } = await svc.listSwitches();
    const weather = switches.find((s) => s.key === 'sys_weather_provider')!;
    expect(weather).toMatchObject({
      enabled: false,
      disabled_reason: 'provider outage',
      disabled_by: 'a1',
      disabled_at: NOW.toISOString(),
    });
  });

  it('disableSwitch() upserts a force_off row with reason + actor and returns the refreshed dto', async () => {
    const { svc, featureStates } = makeService();
    const res = await svc.disableSwitch(
      'sys_weather_provider',
      { reason: 'incident 123' },
      'admin-1',
    );
    expect(featureStates.save).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: 'sys_weather_provider',
        state: 'force_off',
        reason: 'incident 123',
        updated_by: 'admin-1',
      }),
    );
    expect(res).toMatchObject({
      key: 'sys_weather_provider',
      enabled: false,
      disabled_reason: 'incident 123',
      disabled_by: 'admin-1',
    });
  });

  it('disableSwitch() updates an existing row in place rather than duplicating it', async () => {
    const { svc, featureStates } = makeService({
      states: [
        {
          feature: 'sys_weather_provider',
          state: 'force_off',
          reason: 'first incident',
          updated_by: 'a1',
          updated_at: NOW,
          created_at: NOW,
        },
      ],
    });
    await svc.disableSwitch(
      'sys_weather_provider',
      { reason: 'second incident' },
      'admin-2',
    );
    expect(featureStates.create).not.toHaveBeenCalled();
    const { switches } = await svc.listSwitches();
    expect(
      switches.filter((s) => s.key === 'sys_weather_provider'),
    ).toHaveLength(1);
    expect(
      switches.find((s) => s.key === 'sys_weather_provider'),
    ).toMatchObject({
      disabled_reason: 'second incident',
      disabled_by: 'admin-2',
    });
  });

  it('disableSwitch() rejects an unknown key', async () => {
    const { svc } = makeService();
    await expect(
      svc.disableSwitch('nope', { reason: 'x' }, 'admin-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('disableSwitch() rejects a toggle key — not a system switch', async () => {
    const { svc } = makeService();
    await expect(
      svc.disableSwitch('gpx_export', { reason: 'x' }, 'admin-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('disableSwitch() rejects a limit key — not a system switch', async () => {
    const { svc } = makeService();
    await expect(
      svc.disableSwitch('max_active_trips', { reason: 'x' }, 'admin-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('enableSwitch() deletes the row by feature', async () => {
    const { svc, featureStates } = makeService({
      states: [
        {
          feature: 'sys_weather_provider',
          state: 'force_off',
          reason: 'x',
          updated_by: 'a1',
          updated_at: NOW,
          created_at: NOW,
        },
      ],
    });
    await svc.enableSwitch('sys_weather_provider');
    expect(featureStates.delete).toHaveBeenCalledWith({
      feature: 'sys_weather_provider',
    });
    const { switches } = await svc.listSwitches();
    expect(
      switches.find((s) => s.key === 'sys_weather_provider'),
    ).toMatchObject({ enabled: true, disabled_reason: null });
  });

  it('enableSwitch() is idempotent — deleting an absent row does not throw', async () => {
    const { svc, featureStates } = makeService();
    await svc.enableSwitch('sys_weather_provider');
    await expect(
      svc.enableSwitch('sys_weather_provider'),
    ).resolves.toBeUndefined();
    expect(featureStates.delete).toHaveBeenCalledTimes(2);
  });

  it('enableSwitch() rejects an unknown key', async () => {
    const { svc } = makeService();
    await expect(svc.enableSwitch('nope')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('enableSwitch() rejects a toggle or limit key — not a system switch', async () => {
    const { svc } = makeService();
    await expect(svc.enableSwitch('gpx_export')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.enableSwitch('max_active_trips')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
