/**
 * Build-time script to export the OpenAPI spec as YAML.
 *
 * Usage (after `nest build --config nest-cli.openapi.json`):
 *   node dist/scripts/export-openapi.js
 *
 * Writes openapi.yaml to packages/openapi/openapi.yaml.
 * Does NOT require a running database or any external services.
 */

import 'reflect-metadata';
import * as path from 'path';
import * as fs from 'fs';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import * as yaml from 'js-yaml';
import { AppModule } from '../app.module.js';
import { createSwaggerConfig } from '../config/swagger.config.js';
import {
  setupGlobalPrefix,
  stripAdminPathsGlobalPrefix,
} from '../config/global-prefix.js';

// Set OPENAPI_EXPORT so modules can skip heavy initialisation if they check.
process.env['OPENAPI_EXPORT'] = 'true';

// Provide placeholder values so NestJS/TypeORM can construct without a real DB.
// The database.config.ts already has sane defaults, but explicit stubs are
// clearer and make the intent obvious.
process.env['NODE_ENV'] ??= 'development';
process.env['TARMOTO_DATABASE_HOST'] ??= 'localhost';
process.env['TARMOTO_DATABASE_PORT'] ??= '5432';
process.env['TARMOTO_DATABASE_NAME'] ??= 'tarmoto_openapi_export';
process.env['TARMOTO_DATABASE_USER'] ??= 'tarmoto';
process.env['TARMOTO_DATABASE_PASSWORD'] ??= 'tarmoto';
process.env['TARMOTO_REDIS_HOST'] ??= 'localhost';
process.env['TARMOTO_REDIS_PORT'] ??= '6379';
process.env['TARMOTO_JWT_SECRET'] ??= 'DO-NOT-USE-openapi-export-only-00000000';

async function exportSpec(): Promise<void> {
  // NestJS's ExceptionsZone calls process.exit(1) when TypeORM fails to connect
  // at startup (even with retryAttempts: 0). We suppress that so the export can
  // complete: the database connection failure is expected and harmless because
  // the OpenAPI document is generated from metadata, not live data.
  const realExit = process.exit.bind(process);
  let exportDone = false;
  let hangTimeout: NodeJS.Timeout | undefined;

  process.exit = (code?: number) => {
    if ((code ?? 0) !== 0 && !exportDone) {
      // Swallow premature exits from NestJS's error handler — we will call
      // realExit ourselves once the spec has been written.
      // Set a timeout so the script doesn't hang if the swallowed exit
      // was the only thing preventing the event loop from draining.
      if (!hangTimeout) {
        hangTimeout = setTimeout(() => {
          console.error(
            'export-openapi: timed out waiting for bootstrap after swallowed exit',
          );
          realExit(1);
        }, 30_000).unref();
      }
      return undefined as never;
    }
    return realExit(code);
  };

  try {
    const app = await NestFactory.create(AppModule, {
      // Suppress all NestJS startup logs so only our output is visible.
      logger: false,
    });

    setupGlobalPrefix(app);

    const document = stripAdminPathsGlobalPrefix(
      SwaggerModule.createDocument(app, createSwaggerConfig()),
    );

    // __dirname at runtime is <repo>/apps/backend/dist/scripts/
    // Four levels up reaches the repo root.
    const outPath = path.resolve(
      __dirname,
      '../../../../packages/openapi/openapi.yaml',
    );

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, yaml.dump(document, { lineWidth: 120 }));

    const pathCount = Object.keys(document.paths ?? {}).length;
    console.log(`OpenAPI spec written to ${outPath}`);
    console.log(`  paths: ${pathCount}`);

    exportDone = true;
    if (hangTimeout) clearTimeout(hangTimeout);
    await app.close();
  } finally {
    // Always restore process.exit before we return.
    if (hangTimeout) clearTimeout(hangTimeout);
    process.exit = realExit;
  }
}

void exportSpec().catch((err: unknown) => {
  console.error('export-openapi failed:', err);
  process.exit(1);
});
