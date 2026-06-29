import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminContentService } from './admin-content.service.js';
import { ContentType } from './content-types.js';

const HAZARD_ROW = {
  id: 'h1',
  user_id: 'u1',
  note: 'big pothole',
  photo_url: 'https://cdn/x.jpg',
  location: { type: 'Point', coordinates: [10, 50] },
  created_at: new Date('2026-01-01T00:00:00Z'),
  moderation_status: 'visible',
  moderation_reason: null,
  moderated_at: null,
};

function makeQb(rows: object[], total: number) {
  const qb: Record<string, jest.Mock> = {};
  for (const m of ['where', 'andWhere', 'orderBy', 'skip', 'take']) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getManyAndCount = jest.fn().mockResolvedValue([rows, total]);
  return qb;
}

function makeRepo(qb: object, over: Record<string, unknown> = {}) {
  return {
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    findOne: jest.fn().mockResolvedValue(HAZARD_ROW),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    ...over,
  };
}

function makeUserRepo() {
  return {
    find: jest.fn().mockResolvedValue([{ id: 'u1', display_name: 'Alice' }]),
  };
}

function build(hazardRepo: object, userRepo: object) {
  // review + trip repos unused in these cases — pass minimal stubs
  const stub = makeRepo(makeQb([], 0));
  return new AdminContentService(
    hazardRepo as never,
    stub as never,
    stub as never,
    userRepo as never,
  );
}

describe('AdminContentService', () => {
  it('list() projects a normalized row with author name and location', async () => {
    const qb = makeQb([HAZARD_ROW], 1);
    const repo = makeRepo(qb);
    const svc = build(repo, makeUserRepo());
    const res = await svc.list({ type: ContentType.Hazard });
    expect(res.total).toBe(1);
    expect(res.rows[0]).toMatchObject({
      type: 'hazard',
      id: 'h1',
      authorId: 'u1',
      authorName: 'Alice',
      text: 'big pothole',
      photoUrls: ['https://cdn/x.jpg'],
      status: 'visible',
      location: { lat: 50, lng: 10 },
    });
  });

  it('list() applies a status filter when not "all"', async () => {
    const qb = makeQb([], 0);
    const repo = makeRepo(qb);
    const svc = build(repo, makeUserRepo());
    await svc.list({ type: ContentType.Hazard, status: 'hidden' });
    expect(qb.andWhere).toHaveBeenCalledWith('c.moderation_status = :status', {
      status: 'hidden',
    });
  });

  it('list() does not filter status when "all"', async () => {
    const qb = makeQb([], 0);
    const repo = makeRepo(qb);
    const svc = build(repo, makeUserRepo());
    await svc.list({ type: ContentType.Hazard, status: 'all' });
    const statusCalls = qb.andWhere.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('moderation_status'),
    );
    expect(statusCalls).toHaveLength(0);
  });

  it('list() escapes LIKE wildcards in the search term', async () => {
    const qb = makeQb([], 0);
    const repo = makeRepo(qb);
    const svc = build(repo, makeUserRepo());
    await svc.list({ type: ContentType.Hazard, q: '50%_off' });
    expect(qb.andWhere).toHaveBeenCalledWith('c.note ILIKE :q', {
      q: '%50\\%\\_off%',
    });
  });

  it('hide() sets status, reason, actor, timestamp', async () => {
    const repo = makeRepo(makeQb([], 0));
    const svc = build(repo, makeUserRepo());
    await svc.hide(ContentType.Hazard, 'h1', 'admin-9', 'spam');
    expect(repo.update).toHaveBeenCalledWith(
      { id: 'h1' },
      expect.objectContaining({
        moderation_status: 'hidden',
        moderation_reason: 'spam',
        moderated_by: 'admin-9',
      }),
    );
  });

  it('hide() throws NotFound when the row is missing', async () => {
    const repo = makeRepo(makeQb([], 0), {
      update: jest.fn().mockResolvedValue({ affected: 0 }),
    });
    const svc = build(repo, makeUserRepo());
    await expect(
      svc.hide(ContentType.Hazard, 'nope', 'admin-9', null),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('restore() clears the moderation fields', async () => {
    const repo = makeRepo(makeQb([], 0));
    const svc = build(repo, makeUserRepo());
    await svc.restore(ContentType.Hazard, 'h1');
    expect(repo.update).toHaveBeenCalledWith(
      { id: 'h1' },
      {
        moderation_status: 'visible',
        moderation_reason: null,
        moderated_by: null,
        moderated_at: null,
      },
    );
  });

  it('remove() throws NotFound on zero-affected delete', async () => {
    const repo = makeRepo(makeQb([], 0), {
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
    });
    const svc = build(repo, makeUserRepo());
    await expect(svc.remove(ContentType.Hazard, 'nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects an unknown content type', async () => {
    const repo = makeRepo(makeQb([], 0));
    const svc = build(repo, makeUserRepo());
    await expect(svc.list({ type: 'bogus' as never })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
