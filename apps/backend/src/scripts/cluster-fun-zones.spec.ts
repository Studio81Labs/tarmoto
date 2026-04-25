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

  it('rejects non-numeric values for numeric flags', () => {
    expect(() => parseArgs(['--min-curviness=abc'])).toThrow(
      /not a finite number/,
    );
    expect(() => parseArgs(['--eps=foo'])).toThrow(/not a finite number/);
  });

  it('rejects Infinity / -Infinity / NaN as numeric flag values', () => {
    expect(() => parseArgs(['--eps=Infinity'])).toThrow(/not a finite number/);
    expect(() => parseArgs(['--min-curviness=-Infinity'])).toThrow(
      /not a finite number/,
    );
    expect(() => parseArgs(['--min-quality=NaN'])).toThrow(
      /not a finite number/,
    );
  });

  it('rejects fractional values for integer-only flags', () => {
    expect(() => parseArgs(['--min-points=2.5'])).toThrow(/must be an integer/);
    expect(() => parseArgs(['--min-roads-per-zone=3.7'])).toThrow(
      /must be an integer/,
    );
  });

  it('still accepts well-formed numeric values', () => {
    const result = parseArgs([
      '--min-curviness=2.5',
      '--eps=0.06',
      '--min-points=4',
      '--min-roads-per-zone=5',
      '--hull-buffer-m=300',
    ]);
    expect(result.options).toEqual({
      minCurviness: 2.5,
      epsDegrees: 0.06,
      minPoints: 4,
      minRoadsPerZone: 5,
      hullBufferM: 300,
    });
  });
});
