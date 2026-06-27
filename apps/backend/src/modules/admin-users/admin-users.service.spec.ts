import { NotFoundException } from '@nestjs/common';
import { AdminUsersService } from './admin-users.service.js';

function repo<T extends object>(over: Partial<T> = {}): T {
  return {
    findAndCount: jest.fn(),
    findOne: jest.fn(),
    count: jest.fn().mockResolvedValue(0),
    update: jest.fn(),
    ...over,
  } as unknown as T;
}

const SAMPLE_USER = {
  id: 'u1',
  email: 'rider@x.io',
  display_name: 'Rider',
  subscription_tier: 'free',
  subscription_status: 'canceled',
  subscription_current_period_end: null,
  subscription_cancel_at_period_end: false,
  home_region: 'CZ',
  email_verified_at: null,
  created_at: new Date('2026-01-01T00:00:00Z'),
  deleted_at: null,
  deletion_scheduled_at: null,
  deletion_reason: null,
};

function make(over: { users?: object } = {}) {
  const users =
    over.users ??
    repo({
      findAndCount: jest.fn().mockResolvedValue([[SAMPLE_USER], 1]),
      findOne: jest.fn().mockResolvedValue(SAMPLE_USER),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    });
  const activity = () => repo({ count: jest.fn().mockResolvedValue(3) });
  const service = new AdminUsersService(
    users as never,
    activity() as never, // rides
    activity() as never, // hazards
    activity() as never, // reviews
    activity() as never, // trips
    activity() as never, // commutes
  );
  return { service, users };
}

describe('AdminUsersService', () => {
  it('list() returns paginated rows + total', async () => {
    const { service, users } = make();
    const res = await service.list({ page: 1, pageSize: 25 });
    expect(res).toMatchObject({ total: 1, page: 1, pageSize: 25 });
    expect(res.rows[0]).toMatchObject({ id: 'u1', email: 'rider@x.io' });
    expect(users.findAndCount).toHaveBeenCalled();
  });

  it('getById() includes activity counts', async () => {
    const { service } = make();
    const detail = await service.getById('u1');
    expect(detail.activity).toEqual({
      rides: 3,
      hazardReports: 3,
      roadReviews: 3,
      trips: 3,
      commuteRoutes: 3,
    });
  });

  it('getById() throws NotFound for unknown id', async () => {
    const { service } = make({
      users: repo({ findOne: jest.fn().mockResolvedValue(null) }),
    });
    await expect(service.getById('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('softDelete() sets deleted_at + reason', async () => {
    const { service, users } = make();
    await service.softDelete('u1');

    const updateCall = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      deleted_at: expect.any(Date),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      deletion_reason: expect.any(String),
    };
    expect(users.update).toHaveBeenCalledWith({ id: 'u1' }, updateCall);
  });

  it('restore() clears deleted_at + reason', async () => {
    const { service, users } = make();
    await service.restore('u1');
    expect(users.update).toHaveBeenCalledWith(
      { id: 'u1' },
      { deleted_at: null, deletion_scheduled_at: null, deletion_reason: null },
    );
  });

  it('list() applies deleted filter to each search clause', async () => {
    const { service, users } = make();
    await service.list({ q: 'foo', deleted: 'active', page: 1, pageSize: 25 });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const findAndCountCall = expect.objectContaining({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      where: expect.arrayContaining([
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          email: expect.anything(),
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          deleted_at: expect.anything(),
        }),

        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          display_name: expect.anything(),
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          deleted_at: expect.anything(),
        }),
      ]),
    });
    expect(users.findAndCount).toHaveBeenCalledWith(findAndCountCall);
  });
});
