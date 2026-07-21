import { ConcurrencyLimiter, positiveInteger } from './concurrency-limiter.js';

describe('ConcurrencyLimiter', () => {
  it('never runs more than the configured number of tasks', async () => {
    const limiter = new ConcurrencyLimiter(2);
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const tasks = Array.from({ length: 5 }, (_, value) =>
      limiter.run(
        () =>
          new Promise<number>((resolve) => {
            active += 1;
            peak = Math.max(peak, active);
            releases.push(() => {
              active -= 1;
              resolve(value);
            });
          }),
      ),
    );

    await Promise.resolve();
    expect(active).toBe(2);
    while (releases.length > 0 || active > 0) {
      releases.shift()?.();
      await Promise.resolve();
    }
    await expect(Promise.all(tasks)).resolves.toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  it('drops queued work when its signal is aborted', async () => {
    const limiter = new ConcurrencyLimiter(1);
    let release!: () => void;
    const first = limiter.run(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const controller = new AbortController();
    const queued = limiter.run(
      () => Promise.resolve(undefined),
      controller.signal,
    );
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    release();
    await first;
  });
});

describe('positiveInteger', () => {
  it('uses the fallback for invalid values and caps large values', () => {
    expect(positiveInteger(undefined, 2, 10)).toBe(2);
    expect(positiveInteger('0', 2, 10)).toBe(2);
    expect(positiveInteger('3', 2, 10)).toBe(3);
    expect(positiveInteger('99', 2, 10)).toBe(10);
  });
});
