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

function makeHazardsSvc(overrides: Record<string, unknown> = {}) {
  return {
    adminHardDelete: jest.fn().mockResolvedValue(true),
    broadcastRemoval: jest.fn().mockResolvedValue(undefined),
    broadcastRestore: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeReviewsSvc(overrides: Record<string, unknown> = {}) {
  return {
    adminHardDelete: jest.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function build(
  hazardRepo: object,
  userRepo: object,
  hazardsSvc: object = makeHazardsSvc(),
  reviewsSvc: object = makeReviewsSvc(),
) {
  // review + trip repos unused in these cases — pass minimal stubs
  const stub = makeRepo(makeQb([], 0));
  return new AdminContentService(
    hazardRepo as never,
    stub as never,
    stub as never,
    userRepo as never,
    hazardsSvc as never,
    reviewsSvc as never,
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

  it('list() drops a stored photo URL that fails the URL policy', async () => {
    const qb = makeQb([{ ...HAZARD_ROW, photo_url: 'ftp://evil/x.jpg' }], 1);
    const repo = makeRepo(qb);
    const svc = build(repo, makeUserRepo());
    const res = await svc.list({ type: ContentType.Hazard });
    expect(res.rows[0]!.photoUrls).toEqual([]);
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
    const statusCalls = qb.andWhere!.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('moderation_status'),
    );
    expect(statusCalls).toHaveLength(0);
  });

  it('list() defaults to "all" (no status filter) when status is omitted', async () => {
    // API contract: omitting status returns the full moderation queue. The
    // SPA opts into 'visible' explicitly for its index-served default tab.
    const qb = makeQb([], 0);
    const repo = makeRepo(qb);
    const svc = build(repo, makeUserRepo());
    await svc.list({ type: ContentType.Hazard });
    const statusCalls = qb.andWhere!.mock.calls.filter((c: unknown[]) =>
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

  it('remove(hazard) delegates to hazardsService.adminHardDelete', async () => {
    const hazardsSvc = makeHazardsSvc();
    const reviewsSvc = makeReviewsSvc();
    const svc = build(
      makeRepo(makeQb([], 0)),
      makeUserRepo(),
      hazardsSvc,
      reviewsSvc,
    );
    await svc.remove(ContentType.Hazard, 'h1');
    expect(hazardsSvc.adminHardDelete).toHaveBeenCalledWith('h1');
    expect(reviewsSvc.adminHardDelete).not.toHaveBeenCalled();
  });

  it('remove(hazard) throws NotFound when adminHardDelete returns false', async () => {
    const hazardsSvc = makeHazardsSvc({
      adminHardDelete: jest.fn().mockResolvedValue(false),
    });
    const svc = build(makeRepo(makeQb([], 0)), makeUserRepo(), hazardsSvc);
    await expect(svc.remove(ContentType.Hazard, 'nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('remove(review) delegates to reviewsService.adminHardDelete', async () => {
    const hazardsSvc = makeHazardsSvc();
    const reviewsSvc = makeReviewsSvc();
    const svc = build(
      makeRepo(makeQb([], 0)),
      makeUserRepo(),
      hazardsSvc,
      reviewsSvc,
    );
    await svc.remove(ContentType.Review, 'r1');
    expect(reviewsSvc.adminHardDelete).toHaveBeenCalledWith('r1');
    expect(hazardsSvc.adminHardDelete).not.toHaveBeenCalled();
  });

  it('remove(review) throws NotFound when adminHardDelete returns false', async () => {
    const reviewsSvc = makeReviewsSvc({
      adminHardDelete: jest.fn().mockResolvedValue(false),
    });
    const svc = build(
      makeRepo(makeQb([], 0)),
      makeUserRepo(),
      makeHazardsSvc(),
      reviewsSvc,
    );
    await expect(svc.remove(ContentType.Review, 'nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('remove(trip_message) uses generic repo delete and throws NotFound on zero affected', async () => {
    const tripRepo = makeRepo(makeQb([], 0), {
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
    });
    const stubRepo = makeRepo(makeQb([], 0));
    const hazardsSvc = makeHazardsSvc();
    const reviewsSvc = makeReviewsSvc();
    // Instantiate directly so the trip_message slot carries the overridden repo
    // (build() only exposes the hazard repo slot to callers).
    const svc = new AdminContentService(
      stubRepo as never,
      stubRepo as never,
      tripRepo as never,
      makeUserRepo() as never,
      hazardsSvc as never,
      reviewsSvc as never,
    );
    await expect(
      svc.remove(ContentType.TripMessage, 'tm1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    // Neither service's adminHardDelete should be called for trip_message
    expect(hazardsSvc.adminHardDelete).not.toHaveBeenCalled();
    expect(reviewsSvc.adminHardDelete).not.toHaveBeenCalled();
  });

  it('hide(hazard) calls broadcastRemoval after the update succeeds', async () => {
    const repo = makeRepo(makeQb([], 0));
    const hazardsSvc = makeHazardsSvc();
    const svc = build(repo, makeUserRepo(), hazardsSvc);
    await svc.hide(ContentType.Hazard, 'h1', 'admin-9', 'spam');
    expect(hazardsSvc.broadcastRemoval).toHaveBeenCalledWith('h1');
  });

  it('hide(hazard) does NOT call broadcastRemoval when the row is missing', async () => {
    const repo = makeRepo(makeQb([], 0), {
      update: jest.fn().mockResolvedValue({ affected: 0 }),
    });
    const hazardsSvc = makeHazardsSvc();
    const svc = build(repo, makeUserRepo(), hazardsSvc);
    await expect(
      svc.hide(ContentType.Hazard, 'nope', 'admin-9', null),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(hazardsSvc.broadcastRemoval).not.toHaveBeenCalled();
  });

  it('hide(review) does NOT call broadcastRemoval', async () => {
    const repo = makeRepo(makeQb([], 0));
    const hazardsSvc = makeHazardsSvc();
    const svc = build(repo, makeUserRepo(), hazardsSvc);
    await svc.hide(ContentType.Review, 'r1', 'admin-9', null);
    expect(hazardsSvc.broadcastRemoval).not.toHaveBeenCalled();
  });

  it('hide(trip_message) does NOT call broadcastRemoval', async () => {
    const repo = makeRepo(makeQb([], 0));
    const hazardsSvc = makeHazardsSvc();
    const svc = build(repo, makeUserRepo(), hazardsSvc);
    await svc.hide(ContentType.TripMessage, 'tm1', 'admin-9', null);
    expect(hazardsSvc.broadcastRemoval).not.toHaveBeenCalled();
  });

  it('remove(hazard) does NOT call broadcastRemoval directly (broadcast is internal to adminHardDelete)', async () => {
    const hazardsSvc = makeHazardsSvc();
    const svc = build(makeRepo(makeQb([], 0)), makeUserRepo(), hazardsSvc);
    await svc.remove(ContentType.Hazard, 'h1');
    expect(hazardsSvc.adminHardDelete).toHaveBeenCalledWith('h1');
    expect(hazardsSvc.broadcastRemoval).not.toHaveBeenCalled();
  });

  it('remove(review) does NOT call broadcastRemoval', async () => {
    const hazardsSvc = makeHazardsSvc();
    const reviewsSvc = makeReviewsSvc();
    const svc = build(
      makeRepo(makeQb([], 0)),
      makeUserRepo(),
      hazardsSvc,
      reviewsSvc,
    );
    await svc.remove(ContentType.Review, 'r1');
    expect(hazardsSvc.broadcastRemoval).not.toHaveBeenCalled();
  });

  it('remove(trip_message) does NOT call broadcastRemoval', async () => {
    const hazardsSvc = makeHazardsSvc();
    const reviewsSvc = makeReviewsSvc();
    const svc = build(
      makeRepo(makeQb([], 0)),
      makeUserRepo(),
      hazardsSvc,
      reviewsSvc,
    );
    await svc.remove(ContentType.TripMessage, 'tm1');
    expect(hazardsSvc.broadcastRemoval).not.toHaveBeenCalled();
  });

  it('restore(hazard) calls broadcastRestore after the update succeeds', async () => {
    const repo = makeRepo(makeQb([], 0));
    const hazardsSvc = makeHazardsSvc();
    const svc = build(repo, makeUserRepo(), hazardsSvc);
    await svc.restore(ContentType.Hazard, 'h1');
    expect(hazardsSvc.broadcastRestore).toHaveBeenCalledWith('h1');
  });

  it('restore(review) does NOT call broadcastRestore', async () => {
    const hazardsSvc = makeHazardsSvc();
    const svc = build(makeRepo(makeQb([], 0)), makeUserRepo(), hazardsSvc);
    await svc.restore(ContentType.Review, 'r1');
    expect(hazardsSvc.broadcastRestore).not.toHaveBeenCalled();
  });

  it('restore(trip_message) does NOT call broadcastRestore', async () => {
    const hazardsSvc = makeHazardsSvc();
    const svc = build(makeRepo(makeQb([], 0)), makeUserRepo(), hazardsSvc);
    await svc.restore(ContentType.TripMessage, 'tm1');
    expect(hazardsSvc.broadcastRestore).not.toHaveBeenCalled();
  });

  it('rejects an unknown content type', async () => {
    const repo = makeRepo(makeQb([], 0));
    const svc = build(repo, makeUserRepo());
    await expect(svc.list({ type: 'bogus' as never })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
