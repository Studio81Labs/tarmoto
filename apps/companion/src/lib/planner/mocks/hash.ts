/**
 * Deterministic seeding for the planner mocks. Everything fake in the
 * planner derives from a hash of real route geometry, so a given route
 * always renders the same quality story across re-renders, reroutes back
 * to the same line, and test runs.
 */

/** djb2 over a string — stable, fast, good enough spread for fixtures. */
export function hashString(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return hash >>> 0;
}

/** Stable hash for a polyline: first/last/middle vertices at ~11m precision. */
export function hashLineString(
  coordinates: ReadonlyArray<ReadonlyArray<number>>,
): number {
  const pick = [
    coordinates[0],
    coordinates[Math.floor(coordinates.length / 2)],
    coordinates[coordinates.length - 1],
  ];
  const key = pick
    .map((c) => (c ? `${c[0]?.toFixed(4)},${c[1]?.toFixed(4)}` : ""))
    .join(";");
  return hashString(key);
}

/** Deterministic pseudo-random sequence from a seed, values in [0, 1). */
export function seededSequence(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    // xorshift32
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}
