import { AppSettingsService, LAUNCH_TIER_KEY } from './app-settings.service.js';

const NOW = new Date('2026-07-01T00:00:00Z');

function makeService(row: Partial<Record<string, unknown>> | null = null) {
  const settings = {
    findOne: jest.fn().mockResolvedValue(row),
    create: jest.fn().mockImplementation((v: object) => ({
      updated_by: null,
      created_at: NOW,
      updated_at: NOW,
      ...v,
    })),
    save: jest
      .fn()
      .mockImplementation((v: object) =>
        Promise.resolve({ updated_at: NOW, ...v }),
      ),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  return { svc: new AppSettingsService(settings as never), settings };
}

describe('AppSettingsService launch tier', () => {
  it('returns null when no row exists (launch mode off)', async () => {
    const { svc } = makeService(null);
    await expect(svc.getLaunchTier()).resolves.toEqual({
      tier: null,
      updated_by: null,
      updated_at: null,
    });
  });

  it('returns the stored tier when valid', async () => {
    const { svc } = makeService({
      key: LAUNCH_TIER_KEY,
      value: 'premium',
      updated_by: 'admin-1',
      updated_at: NOW,
    });
    await expect(svc.getLaunchTier()).resolves.toEqual({
      tier: 'premium',
      updated_by: 'admin-1',
      updated_at: NOW.toISOString(),
    });
  });

  it('treats a stale/invalid stored value as off (fail-closed)', async () => {
    const { svc } = makeService({
      key: LAUNCH_TIER_KEY,
      value: 'free',
      updated_by: 'admin-1',
      updated_at: NOW,
    });
    await expect(svc.getLaunchTier()).resolves.toMatchObject({ tier: null });
  });

  it('setLaunchTier(tier) upserts the row with the admin actor', async () => {
    const { svc, settings } = makeService(null);
    await svc.setLaunchTier('pro', 'admin-1');
    expect(settings.save).toHaveBeenCalledWith(
      expect.objectContaining({
        key: LAUNCH_TIER_KEY,
        value: 'pro',
        updated_by: 'admin-1',
      }),
    );
  });

  it('setLaunchTier(null) deletes the row (off)', async () => {
    const { svc, settings } = makeService({
      key: LAUNCH_TIER_KEY,
      value: 'pro',
      updated_by: 'admin-1',
      updated_at: NOW,
    });
    await expect(svc.setLaunchTier(null, 'admin-1')).resolves.toEqual({
      tier: null,
      updated_by: null,
      updated_at: null,
    });
    expect(settings.delete).toHaveBeenCalledWith({ key: LAUNCH_TIER_KEY });
    expect(settings.save).not.toHaveBeenCalled();
  });
});
