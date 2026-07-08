import { MinSpacingLimiter, GeocoderBusyError } from './min-spacing-limiter.js';

// Deterministic clock; `sleep` records the requested delay but does NOT advance
// the clock — modelling a burst of callers that all arrive at the same instant
// (their sync slot reservations happen before any real time passes).
function harness(minSpacingMs: number, maxWaitMs: number) {
  let clock = 0;
  const sleeps: number[] = [];
  const limiter = new MinSpacingLimiter(
    minSpacingMs,
    maxWaitMs,
    () => clock,
    (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  );
  return {
    limiter,
    sleeps,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

describe('MinSpacingLimiter', () => {
  it('runs the first task immediately with no wait', async () => {
    const { limiter, sleeps } = harness(1000, 4000);
    expect(await limiter.schedule(() => Promise.resolve('a'))).toBe('a');
    expect(sleeps).toEqual([]);
  });

  it('spaces concurrent tasks by minSpacing, in arrival order', async () => {
    const { limiter, sleeps } = harness(1000, 4000);
    const results = await Promise.all([
      limiter.schedule(() => Promise.resolve(1)),
      limiter.schedule(() => Promise.resolve(2)),
      limiter.schedule(() => Promise.resolve(3)),
    ]);
    expect(results).toEqual([1, 2, 3]);
    expect(sleeps).toEqual([1000, 2000]); // 1st immediate, 2nd +1s, 3rd +2s
  });

  it('rejects a task that would wait beyond maxWait (sheds burst load)', async () => {
    const { limiter } = harness(1000, 2000); // admits waits of 0/1/2s
    const admitted = [
      limiter.schedule(() => Promise.resolve('a')),
      limiter.schedule(() => Promise.resolve('b')),
      limiter.schedule(() => Promise.resolve('c')),
    ];
    // 4th would wait 3s > 2s cap → rejected, not queued.
    await expect(
      limiter.schedule(() => Promise.resolve('d')),
    ).rejects.toBeInstanceOf(GeocoderBusyError);
    expect(await Promise.all(admitted)).toEqual(['a', 'b', 'c']);
  });

  it('does not penalize tasks that arrive spaced out', async () => {
    const h = harness(1000, 4000);
    await h.limiter.schedule(() => Promise.resolve('a'));
    h.tick(5000); // well past the reserved slot
    await h.limiter.schedule(() => Promise.resolve('b'));
    expect(h.sleeps).toEqual([]); // neither had to wait
  });

  it('is a no-op when minSpacing is 0 (self-hosted: no spacing, no shedding)', async () => {
    const { limiter, sleeps } = harness(0, 4000);
    const results = await Promise.all([
      limiter.schedule(() => Promise.resolve(1)),
      limiter.schedule(() => Promise.resolve(2)),
      limiter.schedule(() => Promise.resolve(3)),
    ]);
    expect(results).toEqual([1, 2, 3]);
    expect(sleeps).toEqual([]);
  });
});
