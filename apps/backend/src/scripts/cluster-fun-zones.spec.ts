import { parseArgs } from './cluster-fun-zones-args.js';

describe('cluster-fun-zones CLI parseArgs', () => {
  it('returns empty options for no args', () => {
    expect(parseArgs([])).toEqual({ options: {} });
  });

  it('parses --no-prune as a valueless boolean flag', () => {
    expect(parseArgs(['--no-prune'])).toEqual({
      options: { pruneStaleZones: false },
    });
  });

  it('rejects --no-prune=anything (not a value-taking flag)', () => {
    expect(() => parseArgs(['--no-prune=true'])).toThrow(
      /does not take a value/i,
    );
  });

  it('rejects value-taking flags supplied without a value', () => {
    expect(() => parseArgs(['--eps'])).toThrow(/requires a value/i);
  });

  it('rejects unknown flags', () => {
    expect(() => parseArgs(['--what-now=42'])).toThrow(/unknown argument/i);
  });

  it('parses bbox into a tuple', () => {
    expect(parseArgs(['--bbox=10.1,46.5,12.5,47.7'])).toEqual({
      options: { bbox: [10.1, 46.5, 12.5, 47.7] },
    });
  });

  it('rejects malformed bbox', () => {
    expect(() => parseArgs(['--bbox=not,a,bbox'])).toThrow();
    expect(() => parseArgs(['--bbox=10,46,9,47'])).toThrow(/min must be < max/);
  });

  it('combines flags including --no-prune', () => {
    const result = parseArgs([
      '--bbox=10,46,12,47',
      '--eps=0.06',
      '--min-points=4',
      '--no-prune',
    ]);
    expect(result.options).toMatchObject({
      bbox: [10, 46, 12, 47],
      epsDegrees: 0.06,
      minPoints: 4,
      pruneStaleZones: false,
    });
  });
});
