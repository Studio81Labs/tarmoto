import { Module, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule, type TypeOrmModuleOptions } from '@nestjs/typeorm';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { Poi } from '../../entities/poi.entity.js';
import { poiDatabaseConfig } from '../../config/poi-database.config.js';
import { AddPois1787000000000 } from '../../migrations-poi/1787000000000-AddPois.js';
import { AddPoiDecisionSupportFields1793000000000 } from '../../migrations-poi/1793000000000-AddPoiDecisionSupportFields.js';
import { isPoiConnectionError } from './poi-repo.js';

const logger = new Logger('PoiDatabase');
const RETRY_MS = 10_000;
// Bound the runtime connect attempt (below) so a reachable-but-unresponsive
// POI host (e.g. a dropped SYN) can't block boot for the OS TCP timeout
// (~1-2 min). A failed/hung connect gives up fast instead, gets swallowed by
// createPoiDataSource, and retries in the background.
const CONNECT_TIMEOUT_MS = 5_000;

// Build + attempt to connect the POI DataSource. A CONNECTION failure (the
// POI DB is unreachable) never throws (ADR 0007's tolerate-down): the app
// still boots, and the store services 503 until a background retry connects.
// A NON-connection failure (e.g. a real schema/migration DDL error —
// `migrationsRun: true` below applies the POI migrations on connect — or a
// config mistake) IS rethrown at boot, so it fails fast and visibly instead
// of being masked as a transient outage and retried forever, exactly like a
// failed app-DB migration crashes boot today.
export async function createPoiDataSource(
  options: DataSourceOptions,
): Promise<DataSource> {
  const ds = new DataSource(options);
  // `isBoot` distinguishes the initial awaited attempt from a later
  // background retry: only the boot attempt is still inside an `await`
  // NestFactory.create can fail on. A throw from a background retry
  // (post-boot) would be an unhandled rejection with no one awaiting it, so
  // that path just logs and stops instead of throwing.
  const attempt = async (isBoot: boolean): Promise<void> => {
    try {
      await ds.initialize();
      logger.log('POI database connected');
    } catch (err) {
      if (!isPoiConnectionError(err)) {
        // Not connectivity — ADR 0007's tolerate-down/retry treatment is
        // only for the POI DB being unreachable. Retrying a genuine bug
        // forever would hide it indefinitely instead of surfacing it.
        logger.error(
          `POI database initialization failed (non-connection error — likely a schema/migration/config bug, not a transient outage): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        if (isBoot) throw err;
        return;
      }
      logger.error(
        `POI database unavailable — POI store reads will 503 until it connects: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // Retry in the background so the app never blocks or fails boot on the
      // POI DB. `.unref()` keeps this timer from holding the process (or the
      // Jest worker in this module's spec) open — it must never be a reason
      // the process can't exit cleanly.
      const timer = setTimeout(() => void attempt(false), RETRY_MS);
      timer.unref();
    }
  };
  await attempt(true);
  return ds;
}

// Exported (rather than inlined into `useFactory` below) so
// poi-database.module.spec.ts can assert the `migrationsRun` gating without
// booting the whole module.
export function buildPoiTypeOrmOptions(
  config: ConfigService,
): TypeOrmModuleOptions {
  // Mirrors DatabaseModule's gating in database.module.ts: OPENAPI_EXPORT is
  // set by scripts/export-openapi.ts, which builds the app purely from
  // Nest/Swagger metadata and needs no real DB. Without this gate,
  // `migrationsRun: true` would run POI migrations (a write) against the POI
  // DB every time the OpenAPI spec is generated.
  const isOpenApiExport = process.env['OPENAPI_EXPORT'] === 'true';
  const host = config.get<string>('poiDatabase.host');
  const port = config.get<number>('poiDatabase.port');
  const database = config.get<string>('poiDatabase.database');
  const username = config.get<string>('poiDatabase.username');
  const password = config.get<string>('poiDatabase.password');
  return {
    type: 'postgres',
    name: 'poi',
    ...(host !== undefined ? { host } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(database !== undefined ? { database } : {}),
    ...(username !== undefined ? { username } : {}),
    ...(password !== undefined ? { password } : {}),
    entities: [Poi],
    migrations: [
      AddPois1787000000000,
      AddPoiDecisionSupportFields1793000000000,
    ],
    migrationsRun: !isOpenApiExport,
    synchronize: false,
    // We own retries in createPoiDataSource; don't let TypeORM's own
    // retry loop throw at boot.
    retryAttempts: 0,
    // `@nestjs/typeorm`'s createDataSourceFactory re-initializes
    // whatever DataSource dataSourceFactory returns unless this is
    // set: `!dataSource.isInitialized && !options.manualInitialization
    // ? dataSource.initialize() : dataSource`. Without it, a POI DB
    // that's down at boot means NestJS re-runs initialize() on the
    // very DataSource createPoiDataSource just swallowed the failure
    // for — that second initialize() call rejects, retryAttempts: 0
    // makes handleRetry re-throw immediately, and
    // NestFactory.create(AppModule) crashes the whole process. With
    // manualInitialization, NestJS returns createPoiDataSource's
    // result as-is (an uninitialized DataSource on failure), so boot
    // survives and the store services 503 instead (ADR 0007).
    manualInitialization: true,
    // See CONNECT_TIMEOUT_MS above. Both fields matter: connectTimeoutMS
    // is TypeORM's own Postgres option; extra.connectionTimeoutMillis
    // sets it directly on the pg Pool. Belt-and-suspenders — TypeORM's
    // PostgresDriver#createPool merges `options.extra` over the
    // connectTimeoutMS-derived default, so either alone would apply,
    // but pinning both keeps this resilient to that merge order.
    connectTimeoutMS: CONNECT_TIMEOUT_MS,
    extra: { connectionTimeoutMillis: CONNECT_TIMEOUT_MS },
  };
}

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      name: 'poi',
      imports: [ConfigModule.forFeature(poiDatabaseConfig)],
      inject: [ConfigService],
      useFactory: buildPoiTypeOrmOptions,
      dataSourceFactory: (options) => createPoiDataSource(options!),
    }),
  ],
})
export class PoiDatabaseModule {}
