import { NotFoundException } from '@nestjs/common';
import { AdminEmailService } from './admin-email.service.js';

function makeQb(result: [unknown[], number]) {
  const qb = {
    orderBy: jest.fn(),
    skip: jest.fn(),
    take: jest.fn(),
    andWhere: jest.fn(),
    getManyAndCount: jest.fn().mockResolvedValue(result),
  };
  qb.orderBy.mockReturnValue(qb);
  qb.skip.mockReturnValue(qb);
  qb.take.mockReturnValue(qb);
  qb.andWhere.mockReturnValue(qb);
  return qb;
}

const SAMPLE_ROW = {
  id: 'log-1',
  recipient: 'rider@tarmoto.app',
  tag: 'weekly-digest',
  subject: 'Your week on Tarmoto',
  status: 'sent',
  provider: 'resend',
  provider_message_id: 'res_1',
  error_class: null,
  created_at: new Date('2026-07-05T08:00:00Z'),
};

function make(result: [unknown[], number] = [[SAMPLE_ROW], 1]) {
  const qb = makeQb(result);
  const emailLog = { createQueryBuilder: jest.fn().mockReturnValue(qb) };

  const usersQb = {
    select: jest.fn(),
    where: jest.fn(),
    getRawOne: jest.fn().mockResolvedValue({ id: 'u1' }),
  };
  usersQb.select.mockReturnValue(usersQb);
  usersQb.where.mockReturnValue(usersQb);
  const users = { createQueryBuilder: jest.fn().mockReturnValue(usersQb) };

  const email = {
    sendWeeklyDigest: jest
      .fn()
      .mockResolvedValue({ providerMessageId: 'm', providerName: 'resend' }),
  };
  const digestQueue = { add: jest.fn().mockResolvedValue(undefined) };
  const config = { get: jest.fn().mockReturnValue('https://app.tarmoto.app') };

  const service = new AdminEmailService(
    emailLog as never,
    users as never,
    email as never,
    digestQueue as never,
    config as never,
  );
  return { service, qb, usersQb, email, digestQueue };
}

describe('AdminEmailService', () => {
  it('returns paginated rows with an ISO created_at and no body fields', async () => {
    const { service } = make();
    const res = await service.list({ page: 2, pageSize: 10 });
    expect(res).toMatchObject({ total: 1, page: 2, pageSize: 10 });
    expect(res.rows[0]).toMatchObject({
      id: 'log-1',
      status: 'sent',
      provider_message_id: 'res_1',
      created_at: '2026-07-05T08:00:00.000Z',
    });
    // The log is metadata only — the row shape carries no rendered body.
    expect(res.rows[0]).not.toHaveProperty('html');
    expect(res.rows[0]).not.toHaveProperty('text');
  });

  it('paginates with skip/take derived from page/pageSize', async () => {
    const { service, qb } = make();
    await service.list({ page: 3, pageSize: 20 });
    expect(qb.skip).toHaveBeenCalledWith(40); // (3 - 1) * 20
    expect(qb.take).toHaveBeenCalledWith(20);
  });

  it('applies status, tag and an indexed exact (lowercased) recipient filter', async () => {
    const { service, qb } = make();
    await service.list({
      status: 'failed',
      tag: 'weekly-digest',
      recipient: 'Rider@X.io',
    });
    expect(qb.andWhere).toHaveBeenCalledWith('e.status = :status', {
      status: 'failed',
    });
    expect(qb.andWhere).toHaveBeenCalledWith('e.tag = :tag', {
      tag: 'weekly-digest',
    });
    // Exact match (not a leading-wildcard ILIKE) so the recipient index is used;
    // the term is lowercased to match how recipients are stored.
    expect(qb.andWhere).toHaveBeenCalledWith('e.recipient = :recipient', {
      recipient: 'rider@x.io',
    });
  });

  it('adds no filters when none are supplied', async () => {
    const { service, qb } = make();
    await service.list({});
    expect(qb.andWhere).not.toHaveBeenCalled();
  });

  describe('sendTestDigest', () => {
    it('sends a sample weekly digest to the given address', async () => {
      const { service, email } = make();
      const res = await service.sendTestDigest('admin@tarmoto.app');
      expect(res).toEqual({ status: 'sent' });
      const [to, ctx] = email.sendWeeklyDigest.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect(to).toBe('admin@tarmoto.app');
      expect(typeof ctx.rideCount).toBe('number');
      expect(ctx.units).toBe('metric');
      expect(ctx.exploreUrl).toContain('/explore');
    });

    it('reports failed when the provider swallowed the send (null)', async () => {
      const { service, email } = make();
      email.sendWeeklyDigest.mockResolvedValue(null);
      expect(await service.sendTestDigest('admin@tarmoto.app')).toEqual({
        status: 'failed',
      });
    });
  });

  describe('resendDigest', () => {
    it('resolves the recipient (case-insensitively) and queues a 7-day resend', async () => {
      const { service, digestQueue, usersQb } = make();
      const res = await service.resendDigest('Rider@X.io');
      expect(res).toEqual({ status: 'queued', user_id: 'u1' });
      // Case-insensitive, lowercased match.
      expect(usersQb.where).toHaveBeenCalledWith('LOWER(u.email) = :email', {
        email: 'rider@x.io',
      });
      const [, data, opts] = digestQueue.add.mock.calls[0] as [
        string,
        {
          user_id: string;
          for_local_window: string;
          window_start: string;
          window_end: string;
        },
        { jobId: string; priority: number },
      ];
      expect(data.user_id).toBe('u1');
      // Unique per-click token + distinct jobId → never dedups against the
      // failed weekly job.
      expect(data.for_local_window).toMatch(/^resend-\d+$/);
      expect(opts.jobId).toMatch(/^digest-resend:u1:resend-\d+$/);
      const span =
        new Date(data.window_end).getTime() -
        new Date(data.window_start).getTime();
      expect(span).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it('404s and enqueues nothing when no user has that recipient', async () => {
      const { service, usersQb, digestQueue } = make();
      usersQb.getRawOne.mockResolvedValue(undefined);
      await expect(service.resendDigest('nobody@x.io')).rejects.toThrow(
        NotFoundException,
      );
      expect(digestQueue.add).not.toHaveBeenCalled();
    });
  });
});
