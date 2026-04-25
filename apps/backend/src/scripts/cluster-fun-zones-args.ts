/**
 * Argument parser for `cluster-fun-zones`. Lives in its own module so
 * unit tests can exercise it without booting the Nest app.
 */
import type { FunZoneClusteringOptions } from '../modules/roads/fun-zone-clustering.service.js';

export interface ParsedArgs {
  options: FunZoneClusteringOptions;
}

function parseBbox(value: string): [number, number, number, number] {
  const parts = value.split(',').map((s) => Number.parseFloat(s.trim()));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
    throw new Error(
      `Invalid --bbox: ${value}. Expected "west,south,east,north".`,
    );
  }
  const [w, s, e, n] = parts;
  if (w >= e || s >= n) {
    throw new Error(`Invalid --bbox: min must be < max for both axes.`);
  }
  return [w, s, e, n];
}

// Boolean flags don't take a value — `--no-prune` toggles `pruneStaleZones`.
// Listed explicitly so an unknown valueless flag still errors out.
const VALUELESS_FLAGS = new Set(['no-prune']);

export function parseArgs(argv: string[]): ParsedArgs {
  const options: FunZoneClusteringOptions = {};
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const [keyRaw, valueRaw] = raw.replace(/^--/, '').split('=');
    const key = keyRaw.toLowerCase();
    if (VALUELESS_FLAGS.has(key)) {
      if (valueRaw !== undefined) {
        throw new Error(`Argument --${key} does not take a value.`);
      }
      switch (key) {
        case 'no-prune':
          options.pruneStaleZones = false;
          break;
      }
      continue;
    }
    if (valueRaw === undefined) {
      throw new Error(`Argument ${raw} requires a value (use --key=value).`);
    }
    switch (key) {
      case 'bbox':
        options.bbox = parseBbox(valueRaw);
        break;
      case 'min-curviness':
        options.minCurviness = Number(valueRaw);
        break;
      case 'min-quality':
        options.minQuality = Number(valueRaw);
        break;
      case 'min-confidence':
        options.minConfidence = Number(valueRaw);
        break;
      case 'min-segment-length-m':
        options.minSegmentLengthM = Number(valueRaw);
        break;
      case 'eps':
        options.epsDegrees = Number(valueRaw);
        break;
      case 'min-points':
        options.minPoints = Number(valueRaw);
        break;
      case 'min-roads-per-zone':
        options.minRoadsPerZone = Number(valueRaw);
        break;
      case 'hull-buffer-m':
        options.hullBufferM = Number(valueRaw);
        break;
      default:
        throw new Error(`Unknown argument: ${raw}`);
    }
  }
  return { options };
}
