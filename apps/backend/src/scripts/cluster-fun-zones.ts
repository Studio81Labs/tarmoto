/**
 * CLI entry point to (re)cluster `road_segments` into `fun_zones`.
 *
 * Usage (after `pnpm build:backend`):
 *   node dist/scripts/cluster-fun-zones.js
 *   node dist/scripts/cluster-fun-zones.js --bbox=18.0,49.3,18.85,49.7
 *   node dist/scripts/cluster-fun-zones.js --eps=0.06 --min-points=4
 *   node dist/scripts/cluster-fun-zones.js --no-prune
 *
 * The job reads from the configured Tarmoto database and writes to the
 * same database, so a real connection is required (unlike the OpenAPI
 * exporter, which stubs it).
 *
 * Designed to be safe to re-run: zone IDs are deterministic from member
 * segment IDs, and the run prunes zones that no longer exist (scoped
 * to `--bbox` when one is provided, so partial runs don't delete
 * out-of-scope zones).
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { FunZoneClusteringService } from '../modules/roads/fun-zone-clustering.service.js';
import { parseArgs } from './cluster-fun-zones-args.js';

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
