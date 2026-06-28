import { ConflictException, NotFoundException } from '@nestjs/common';
import { AdminFlagsService } from './admin-flags.service.js';

const ROW = {
  id: 'f1',
  key: 'group_rides',
  enabled: false,
  description: null,
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
};

function makeRepo(over: Record<string, unknown> = {}) {
  return {
    find: jest.fn().mockResolvedValue([ROW]),
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockImplementation((v: object) => ({ ...ROW, ...v })),
    save: jest
      .fn()
      .mockImplementation((v: object) => Promise.resolve({ ...ROW, ...v })),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    ...over,
  };
}

describe('AdminFlagsService', () => {
  it('list() returns mapped rows ordered by key', async () => {
    const repo = makeRepo();
    const svc = new AdminFlagsService(repo as never);
    const res = await svc.list();
    expect(res[0]).toMatchObject({
      id: 'f1',
      key: 'group_rides',
      enabled: false,
    });
    expect(repo.find).toHaveBeenCalledWith({ order: { key: 'ASC' } });
  });

  it('create() inserts a new flag', async () => {
    const repo = makeRepo();
    const svc = new AdminFlagsService(repo as never);
    const res = await svc.create({ key: 'beta_ui', enabled: true });
    expect(res).toMatchObject({ key: 'beta_ui', enabled: true });
    expect(repo.save).toHaveBeenCalled();
  });

  it('create() throws Conflict on a duplicate key (pre-check)', async () => {
    const repo = makeRepo({ findOne: jest.fn().mockResolvedValue(ROW) });
    const svc = new AdminFlagsService(repo as never);
    await expect(svc.create({ key: 'group_rides' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('create() maps a unique-violation (23505) race to Conflict', async () => {
    const repo = makeRepo({
      save: jest.fn().mockRejectedValue({ code: '23505' }),
    });
    const svc = new AdminFlagsService(repo as never);
    await expect(svc.create({ key: 'group_rides' })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('update() changes enabled/description and returns the row', async () => {
    const repo = makeRepo({
      findOne: jest
        .fn()
        .mockResolvedValueOnce(ROW) // existence check
        .mockResolvedValueOnce({
          ...ROW,
          enabled: true,
          updated_at: new Date('2026-02-02T00:00:00Z'),
        }), // re-fetch
    });
    const svc = new AdminFlagsService(repo as never);
    const res = await svc.update('f1', { enabled: true });
    expect(repo.update).toHaveBeenCalledWith({ id: 'f1' }, { enabled: true });
    expect(res.enabled).toBe(true);
    expect(res.updated_at).toBe(new Date('2026-02-02T00:00:00Z').toISOString());
  });

  it('update() throws NotFound for an unknown id', async () => {
    const repo = makeRepo({ findOne: jest.fn().mockResolvedValue(null) });
    const svc = new AdminFlagsService(repo as never);
    await expect(svc.update('nope', { enabled: true })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('remove() deletes; NotFound when nothing deleted', async () => {
    const repo = makeRepo({ findOne: jest.fn().mockResolvedValue(ROW) });
    const svc = new AdminFlagsService(repo as never);
    await svc.remove('f1');
    expect(repo.delete).toHaveBeenCalledWith({ id: 'f1' });

    const repo2 = makeRepo({ findOne: jest.fn().mockResolvedValue(null) });
    const svc2 = new AdminFlagsService(repo2 as never);
    await expect(svc2.remove('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});
