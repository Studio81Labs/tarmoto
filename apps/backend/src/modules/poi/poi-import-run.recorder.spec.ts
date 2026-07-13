import { PoiImportRunRecorder } from './poi-import-run.recorder.js';
import { WIPE_GUARD_WARNING } from './poi-import.service.js';
import { PoiImportRun } from '../../entities/poi-import-run.entity.js';

function mockRepo() {
  const saved: Partial<PoiImportRun>[] = [];
  return {
    saved,
    create: (v: Partial<PoiImportRun>) => v,
    save: jest.fn((v: Partial<PoiImportRun>) => {
      const row = { id: v.id ?? '1', ...v };
      saved.push(row);
      return row;
    }),
    update: jest.fn((id: string, patch: Partial<PoiImportRun>) => {
      saved.push({ id, ...patch });
      return { affected: 1 };
    }),
  };
}

describe('PoiImportRunRecorder', () => {
  it('start() inserts a running row and returns its id', async () => {
    const repo = mockRepo();
    const rec = new PoiImportRunRecorder(repo as never);
    const id = await rec.start({
      source: 'osm',
      regionCode: 'CZ',
      trigger: 'manual',
      jobId: 'job-1',
    });
    expect(id).toBe('1');
    expect(repo.saved[0]).toMatchObject({
      source: 'osm',
      region_code: 'CZ',
      status: 'running',
      trigger: 'manual',
      job_id: 'job-1',
    });
  });

  it('finish() records success with counts and a null skip_reason', async () => {
    const repo = mockRepo();
    const rec = new PoiImportRunRecorder(repo as never);
    await rec.finish('7', {
      region: 'CZ',
      fetched: 10,
      upserted: 9,
      tombstoned: 1,
      skipped: false,
      skipReason: null,
      warning: null,
    });
    expect(repo.update).toHaveBeenCalledWith(
      '7',
      expect.objectContaining({
        status: 'success',
        fetched: 10,
        upserted: 9,
        tombstoned: 1,
        skip_reason: null,
        warning: null,
      }),
    );
  });

  // #847 review (this fix): finish() must also persist ANY non-null advisory
  // the service attaches to a run that still completed as a genuine success
  // (the tombstone wipe-guard's partial-accept path) — not just the
  // fetched/upserted/tombstoned counts and a null skip_reason.
  it('finish() persists a non-null warning verbatim on an otherwise-successful run', async () => {
    const repo = mockRepo();
    const rec = new PoiImportRunRecorder(repo as never);
    await rec.finish('10', {
      region: 'CZ',
      fetched: 60,
      upserted: 60,
      tombstoned: 0,
      skipped: false,
      skipReason: null,
      warning: WIPE_GUARD_WARNING,
    });
    expect(repo.update).toHaveBeenCalledWith(
      '10',
      expect.objectContaining({
        status: 'success',
        skip_reason: null,
        warning: WIPE_GUARD_WARNING,
      }),
    );
  });

  // #847 review: `finish()` must persist the REAL, path-specific reason
  // `PoiImportService` attached to the result (distinct per skip cause) —
  // not synthesize one generic message that can't tell a missing-extract
  // skip from a zero-row skip apart.
  it('finish() persists the real skip reason PoiImportService attached to the result, verbatim', async () => {
    const repo = mockRepo();
    const rec = new PoiImportRunRecorder(repo as never);
    await rec.finish('8', {
      region: 'CZ',
      fetched: 0,
      upserted: 0,
      tombstoned: 0,
      skipped: true,
      skipReason: 'no extract file at /extracts/cz.osm',
      warning: null,
    });
    expect(repo.update).toHaveBeenCalledWith(
      '8',
      expect.objectContaining({
        status: 'skipped',
        skip_reason: 'no extract file at /extracts/cz.osm',
      }),
    );
  });

  it('finish() carries a DIFFERENT skip reason through for a different skip cause (proves it is not a fixed string)', async () => {
    const repo = mockRepo();
    const rec = new PoiImportRunRecorder(repo as never);
    await rec.finish('8b', {
      region: 'CZ',
      fetched: 12,
      upserted: 0,
      tombstoned: 0,
      skipped: true,
      skipReason: 'extract yielded 0 in-bbox rows (fetched=12)',
      warning: null,
    });
    expect(repo.update).toHaveBeenCalledWith(
      '8b',
      expect.objectContaining({
        status: 'skipped',
        skip_reason: 'extract yielded 0 in-bbox rows (fetched=12)',
      }),
    );
  });

  // Defensive fallback only — no current PoiImportService code path produces
  // `skipped: true` with a null `skipReason`, but `finish()` must still
  // record SOMETHING readable rather than a bare `null` if that ever happens.
  it('finish() falls back to a generic message when skipped is true but skipReason is null', async () => {
    const repo = mockRepo();
    const rec = new PoiImportRunRecorder(repo as never);
    await rec.finish('9', {
      region: 'CZ',
      fetched: 3,
      upserted: 0,
      tombstoned: 0,
      skipped: true,
      skipReason: null,
      warning: null,
    });
    expect(repo.update).toHaveBeenCalledWith(
      '9',
      expect.objectContaining({
        status: 'skipped',
        skip_reason: expect.stringContaining('skipped') as string,
      }),
    );
  });

  it('fail() records failed with a truncated error', async () => {
    const repo = mockRepo();
    const rec = new PoiImportRunRecorder(repo as never);
    const long = 'x'.repeat(2500);
    await rec.fail('9', new Error(long));
    const patch = repo.update.mock.calls[0]![1];
    expect(patch.status).toBe('failed');
    expect(patch.error).toHaveLength(2000);
    expect(patch.error?.startsWith('xxx')).toBe(true);
  });
});
