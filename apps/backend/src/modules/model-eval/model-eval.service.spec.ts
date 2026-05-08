import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  MODEL_EVAL_RANDOM_TOKEN,
  ModelEvalService,
  computeAgreement,
} from './model-eval.service.js';
import { deviceFamily } from './model-eval.constants.js';
import { ModelEvalSample } from '../../entities/model-eval-sample.entity.js';
import { Ride } from '../../entities/ride.entity.js';

interface FakeRepo<T> {
  query: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  update: jest.Mock;
  findOne: jest.Mock;
  __saved: T[];
}

function fakeRepo<T extends Record<string, unknown>>(): FakeRepo<T> {
  const saved: T[] = [];
  const repo: FakeRepo<T> = {
    __saved: saved,
    query: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockImplementation((data: T) => ({ ...data })),
    save: jest.fn().mockImplementation((data: T) => {
      const withId = { id: `id-${saved.length + 1}`, ...data } as T;
      saved.push(withId);
      return Promise.resolve(withId);
    }),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    findOne: jest.fn().mockResolvedValue(null),
  };
  return repo;
}

async function buildService(opts: {
  random?: () => number;
  sampleRate?: string;
  samples?: FakeRepo<ModelEvalSample>;
  rides?: FakeRepo<Ride>;
}): Promise<{
  service: ModelEvalService;
  samples: FakeRepo<ModelEvalSample>;
  rides: FakeRepo<Ride>;
}> {
  const samples = opts.samples ?? fakeRepo<ModelEvalSample>();
  const rides = opts.rides ?? fakeRepo<Ride>();
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'TARMOTO_MODEL_EVAL_SAMPLE_RATE') return opts.sampleRate;
      return undefined;
    }),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      ModelEvalService,
      { provide: getRepositoryToken(ModelEvalSample), useValue: samples },
      { provide: getRepositoryToken(Ride), useValue: rides },
      { provide: ConfigService, useValue: config },
      {
        provide: MODEL_EVAL_RANDOM_TOKEN,
        useValue: opts.random ?? ((): number => 0),
      },
    ],
  }).compile();
  const service = moduleRef.get(ModelEvalService);
  return { service, samples, rides };
}

describe('ModelEvalService.maybeSample', () => {
  it('persists a sample row when the random roll is below the sample rate', async () => {
    const { service, samples, rides } = await buildService({
      sampleRate: '1.0',
      random: () => 0,
    });
    rides.findOne.mockResolvedValue({ id: 'r1', bike_id: 'bike-9' });

    const out = await service.maybeSample({
      surface_reading_id: 'sr-1',
      road_segment_id: 'seg-1',
      ride_id: 'r1',
      user_id: 'u1',
      model_version: 'rsc-v1.1.0',
      device_model: 'iPhone 15 Pro',
      predicted_classification: 'good',
    });

    expect(out).not.toBeNull();
    expect(samples.save).toHaveBeenCalledTimes(1);
    expect(samples.__saved[0]).toMatchObject({
      surface_reading_id: 'sr-1',
      road_segment_id: 'seg-1',
      bike_id: 'bike-9',
      model_version: 'rsc-v1.1.0',
      predicted_classification: 'good',
      predicted_score: 4,
    });
  });

  it('rolls past the sample rate and stores nothing', async () => {
    const { service, samples } = await buildService({
      sampleRate: '0.01',
      random: () => 0.5,
    });
    const out = await service.maybeSample({
      surface_reading_id: 'sr-1',
      road_segment_id: 'seg-1',
      ride_id: null,
      user_id: null,
      model_version: 'rsc-v1.1.0',
      device_model: null,
      predicted_classification: 'good',
    });
    expect(out).toBeNull();
    expect(samples.save).not.toHaveBeenCalled();
  });

  it('rejects rows whose predicted_classification has no 1-5 score', async () => {
    const { service, samples } = await buildService({
      sampleRate: '1.0',
      random: () => 0,
    });
    const out = await service.maybeSample({
      surface_reading_id: 'sr-1',
      road_segment_id: 'seg-1',
      ride_id: null,
      user_id: null,
      model_version: 'rsc-v1.1.0',
      device_model: null,
      predicted_classification: 'unknown_label_from_future_client',
    });
    expect(out).toBeNull();
    expect(samples.save).not.toHaveBeenCalled();
  });

  it('falls back to default 0.01 sample rate when env is invalid', async () => {
    const { service, samples } = await buildService({
      sampleRate: 'not-a-number',
      random: () => 0.005,
    });
    const out = await service.maybeSample({
      surface_reading_id: 'sr-1',
      road_segment_id: 'seg-1',
      ride_id: null,
      user_id: null,
      model_version: 'rsc-v1.1.0',
      device_model: null,
      predicted_classification: 'good',
    });
    expect(out).not.toBeNull();
    expect(samples.save).toHaveBeenCalledTimes(1);
  });

  it('returns null without writing when sampleRate is set to zero', async () => {
    const { service, samples } = await buildService({
      sampleRate: '0',
      random: () => 0,
    });
    const out = await service.maybeSample({
      surface_reading_id: 'sr-1',
      road_segment_id: 'seg-1',
      ride_id: null,
      user_id: null,
      model_version: 'rsc-v1.1.0',
      device_model: null,
      predicted_classification: 'good',
    });
    expect(out).toBeNull();
    expect(samples.save).not.toHaveBeenCalled();
  });
});

describe('ModelEvalService.reconcilePending', () => {
  it('marks predicted Good vs aggregate Poor as dangerous', async () => {
    const { service, samples } = await buildService({
      sampleRate: '0',
      random: () => 0,
    });

    samples.query.mockImplementation((sql: string) => {
      if (sql.includes('FROM model_eval_samples mes')) {
        return Promise.resolve([
          {
            id: 'sample-1',
            predicted_score: 4, // good
            model_version: 'rsc-v1.1.0',
            quality_score: 1.8, // round-trip → 2 = poor
            reading_count: 8,
            confidence: 75,
          },
        ]);
      }
      // computeVersionMetrics + maybeRaiseAlert query
      return Promise.resolve([]);
    });

    const result = await service.reconcilePending();
    expect(result).toEqual({ reconciled: 1, dangerous: 1 });
    expect(samples.update).toHaveBeenCalledWith(
      { id: 'sample-1' },
      expect.objectContaining({
        aggregate_score: 1.8,
        aggregate_classification: 'poor',
        aggregate_confidence: 75,
        aggregate_reading_count: 8,
        dangerous_misclassification: true,
      }),
    );
  });

  it('does not flag a single-class disagreement (Excellent vs Good) as dangerous', async () => {
    const { service, samples } = await buildService({
      sampleRate: '0',
    });
    samples.query.mockImplementation((sql: string) => {
      if (sql.includes('FROM model_eval_samples mes')) {
        return Promise.resolve([
          {
            id: 'sample-2',
            predicted_score: 5, // excellent
            model_version: 'rsc-v1.1.0',
            quality_score: 4.2, // good
            reading_count: 6,
            confidence: 70,
          },
        ]);
      }
      return Promise.resolve([]);
    });
    const result = await service.reconcilePending();
    expect(result).toEqual({ reconciled: 1, dangerous: 0 });
    expect(samples.update).toHaveBeenCalledWith(
      { id: 'sample-2' },
      expect.objectContaining({
        dangerous_misclassification: false,
        aggregate_classification: 'good',
      }),
    );
  });

  it('returns zeroed counts when nothing is reconcilable', async () => {
    const { service, samples } = await buildService({});
    samples.query.mockResolvedValue([]);
    const result = await service.reconcilePending();
    expect(result).toEqual({ reconciled: 0, dangerous: 0 });
    expect(samples.update).not.toHaveBeenCalled();
  });
});

describe('ModelEvalService.getMetrics', () => {
  it('shapes the per-version 24h metrics including alert flag', async () => {
    const { service, samples } = await buildService({});
    samples.query.mockImplementation((sql: string) => {
      if (sql.includes('GROUP BY model_version')) {
        return Promise.resolve([
          {
            model_version: 'rsc-v1.1.0',
            sample_count: 200,
            dangerous_count: 4, // 2% > 1.5% alert threshold
            adjacent_count: 190,
            mae: 0.42,
          },
          {
            model_version: 'rsc-v1.0.0',
            sample_count: 100,
            dangerous_count: 0,
            adjacent_count: 99,
            mae: 0.31,
          },
        ]);
      }
      // recomputeAgreements
      return Promise.resolve([]);
    });

    const metrics = await service.getMetrics();
    expect(metrics.window_hours).toBe(24);
    expect(metrics.versions).toHaveLength(2);
    expect(metrics.versions[0]).toMatchObject({
      model_version: 'rsc-v1.1.0',
      sample_count: 200,
      dangerous_misclass_rate: 0.02,
      adjacent_accuracy: 0.95,
      mae: 0.42,
      alert_active: true,
    });
    expect(metrics.versions[1]).toMatchObject({
      model_version: 'rsc-v1.0.0',
      alert_active: false,
    });
  });

  it('returns an empty versions array when nothing reconciled', async () => {
    const { service, samples } = await buildService({});
    samples.query.mockResolvedValue([]);
    const metrics = await service.getMetrics();
    expect(metrics.versions).toEqual([]);
    expect(metrics.cross_device_agreement.segments_evaluated).toBe(0);
    expect(metrics.cross_bike_agreement.segments_evaluated).toBe(0);
  });

  it('issue #496 — refreshes the agreement snapshot when older than the TTL (split-deployment fix)', async () => {
    // First call: snapshot is null, so recomputeAgreements runs.
    // Second call within TTL: snapshot is fresh, no recompute.
    // Third call after the TTL has elapsed: stale, recomputed.
    const { service, samples } = await buildService({});
    samples.query.mockResolvedValue([]);

    // Match only the recomputeAgreements query — its SELECT lists
    // `road_segment_id, predicted_score`, which the version-
    // metrics aggregate does NOT.
    const isRecomputeQuery = ([sql]: [string]): boolean =>
      sql.includes('SELECT road_segment_id, predicted_score');

    await service.getMetrics();
    const recomputeCallsAfterFirst =
      samples.query.mock.calls.filter(isRecomputeQuery).length;
    expect(recomputeCallsAfterFirst).toBe(1);

    await service.getMetrics();
    const recomputeCallsAfterSecond =
      samples.query.mock.calls.filter(isRecomputeQuery).length;
    expect(recomputeCallsAfterSecond).toBe(1);

    // Force the cached snapshot timestamp to be older than the
    // 1-hour TTL so the next getMetrics() refreshes it.
    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    type SnapshotMutable = {
      lastDeviceAgreement: { computed_at: string };
      lastBikeAgreement: { computed_at: string };
    };
    (service as unknown as SnapshotMutable).lastDeviceAgreement.computed_at =
      stale;
    (service as unknown as SnapshotMutable).lastBikeAgreement.computed_at =
      stale;

    await service.getMetrics();
    const recomputeCallsAfterStale =
      samples.query.mock.calls.filter(isRecomputeQuery).length;
    expect(recomputeCallsAfterStale).toBe(2);
  });
});

describe('ModelEvalService.renderMarkdownReport', () => {
  it('produces a stable markdown table including spec targets', async () => {
    const { service, samples } = await buildService({});
    samples.query.mockImplementation((sql: string) => {
      if (sql.includes('GROUP BY model_version')) {
        return Promise.resolve([
          {
            model_version: 'rsc-v1.1.0',
            sample_count: 50,
            dangerous_count: 0,
            adjacent_count: 49,
            mae: 0.21,
          },
        ]);
      }
      return Promise.resolve([]);
    });
    const md = await service.renderMarkdownReport();
    expect(md).toContain('# Tarmoto — Model Evaluation Snapshot');
    expect(md).toContain('| rsc-v1.1.0 | 50 |');
    expect(md).toContain('Spec targets');
    expect(md).toContain('Cross-device agreement');
  });
});

describe('computeAgreement', () => {
  it('returns null score when no segment hits the 3-bucket minimum', () => {
    const out = computeAgreement([
      { segmentId: 's1', score: 4, bucket: 'iphone' },
      { segmentId: 's1', score: 4, bucket: 'samsung' },
    ]);
    expect(out.agreement_score).toBeNull();
    expect(out.segments_evaluated).toBe(0);
  });

  it('counts pairwise agreement within ±1 quality class', () => {
    const out = computeAgreement([
      { segmentId: 's1', score: 4, bucket: 'iphone' },
      { segmentId: 's1', score: 4, bucket: 'samsung' },
      { segmentId: 's1', score: 5, bucket: 'pixel' },
    ]);
    expect(out.agreement_score).toBe(1);
    expect(out.segments_evaluated).toBe(1);
  });

  it('penalises a 2-class spread', () => {
    const out = computeAgreement([
      { segmentId: 's1', score: 5, bucket: 'iphone' },
      { segmentId: 's1', score: 4, bucket: 'samsung' },
      { segmentId: 's1', score: 2, bucket: 'pixel' },
    ]);
    // Pairs: (5,4)=ok, (5,2)=fail, (4,2)=fail → 1/3
    expect(out.agreement_score).toBeCloseTo(1 / 3, 3);
  });

  it('skips rows whose bucket is null (no bike linked)', () => {
    const out = computeAgreement([
      { segmentId: 's1', score: 4, bucket: null },
      { segmentId: 's1', score: 4, bucket: null },
      { segmentId: 's1', score: 5, bucket: null },
    ]);
    expect(out.segments_evaluated).toBe(0);
  });
});

describe('deviceFamily', () => {
  it('issue #496 — returns null for missing device_model so the agreement metric skips the bucket', () => {
    expect(deviceFamily(null)).toBeNull();
    expect(deviceFamily(undefined)).toBeNull();
    expect(deviceFamily('')).toBeNull();
    expect(deviceFamily('   ')).toBeNull();
  });

  it('buckets known vendors by their lowercase prefix', () => {
    expect(deviceFamily('iPhone 15 Pro')).toBe('iphone');
    expect(deviceFamily('Samsung Galaxy S24')).toBe('samsung');
    expect(deviceFamily('Galaxy Note 20')).toBe('samsung');
    expect(deviceFamily('Pixel 8')).toBe('pixel');
  });

  it('issue #496 — does not collapse two real device families plus a missing model into a 3-bucket segment', () => {
    // Pre-fix: a segment hit by an iPhone, a Samsung, and an upload
    // that omitted device_model would qualify as 3 distinct buckets
    // (iphone / samsung / 'unknown') and inflate the cross-device
    // launch metric. Post-fix: the missing-model row produces null,
    // computeAgreement skips it, and the segment is correctly below
    // the 3-distinct minimum.
    const rows = [
      { segmentId: 's1', score: 4, bucket: deviceFamily('iPhone 15') },
      { segmentId: 's1', score: 4, bucket: deviceFamily('Samsung Galaxy S24') },
      { segmentId: 's1', score: 5, bucket: deviceFamily(null) },
    ];
    const out = computeAgreement(rows);
    expect(out.segments_evaluated).toBe(0);
    expect(out.agreement_score).toBeNull();
  });
});
