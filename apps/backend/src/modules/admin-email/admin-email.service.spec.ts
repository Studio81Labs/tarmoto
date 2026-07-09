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
  const repo = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
  const service = new AdminEmailService(repo as never);
  return { service, qb };
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
});
