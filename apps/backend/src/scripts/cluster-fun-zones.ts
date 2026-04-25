/**
 * CLI entry point to (re)cluster `road_segments` into `fun_zones`.
 *
 * Usage (after `pnpm build:backend`):
 *   node dist/scripts/cluster-fun-zones.js
 *   node dist/scripts/cluster-fun-zones.js --bbox=18.0,49.3,18.85,49.7
 *   node dist/scripts/cluster-fun-zones.js --eps=0.06 --min-points=4
 *
 * The job reads from the configured Tarmoto database and writes to the
 * same database, so a real connection is required (unlike the OpenAPI
 * exporter, which stubs it).
 *
 * Designed to be safe to re-run: zone IDs are deterministic from member
 * segment IDs, and the run prunes zones that no longer exist.
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import {
  FunZoneClusteringOptions,
  FunZoneClusteringService,
} from '../modules/roads/fun-zone-clustering.service.js';

interface ParsedArgs {
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

function parseArgs(argv: string[]): ParsedArgs {
  const options: FunZoneClusteringOptions = {};
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const [keyRaw, valueRaw] = raw.replace(/^--/, '').split('=');
    const key = keyRaw.toLowerCase();
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
      case 'no-prune':
        options.pruneStaleZones = false;
        break;
      default:
        throw new Error(`Unknown argument: ${raw}`);
    }
  }
  return { options };
}

async function main(): Promise<void> {
  const { options } = parseArgs(process.argv.slice(2));

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const service = app.get(FunZoneClusteringService);
    const result = await service.runClustering(options);
    console.log('Fun zone clustering complete:');
    console.log(`  zones written : ${result.zones_written}`);
    console.log(`  zones pruned  : ${result.zones_pruned}`);
    console.log(`  members written: ${result.members_written}`);
    console.log(`  duration      : ${result.duration_ms}ms`);
  } finally {
    await app.close();
  }
}

void main().catch((err: unknown) => {
  console.error('cluster-fun-zones failed:', err);
  process.exit(1);
});
