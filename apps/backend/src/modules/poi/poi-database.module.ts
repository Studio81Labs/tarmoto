import { Module, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { buildPoiTypeOrmOptions, poiDatabaseConfig } from '@tarmoto/poi-db';
import { isPoiConnectionError } from './poi-repo.js';

const logger = new Logger('PoiDatabase');
const RETRY_MS = 10_000;

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

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      name: 'poi',
      imports: [ConfigModule.forFeature(poiDatabaseConfig)],
      inject: [ConfigService],
      // Backend still migrates the POI DB in this phase; T5 flips this to false.
      useFactory: (config: ConfigService) =>
        buildPoiTypeOrmOptions(config, { migrationsRun: true }),
      dataSourceFactory: (options) => createPoiDataSource(options!),
    }),
  ],
})
export class PoiDatabaseModule {}
