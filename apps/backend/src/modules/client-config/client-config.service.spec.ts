import { ClientConfigService } from './client-config.service.js';

describe('ClientConfigService', () => {
  it('flags() returns a flat key→enabled map', async () => {
    const repo = {
      find: jest.fn().mockResolvedValue([
        { key: 'group_rides', enabled: true },
        { key: 'beta_ui', enabled: false },
      ]),
    };
    const svc = new ClientConfigService(repo as never);
    await expect(svc.flags()).resolves.toEqual({
      group_rides: true,
      beta_ui: false,
    });
    expect(repo.find).toHaveBeenCalledWith({
      select: { key: true, enabled: true },
    });
  });
});
