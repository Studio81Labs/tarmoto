import { Module, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { Poi } from '../../entities/poi.entity.js';
import { poiDatabaseConfig } from '../../config/poi-database.config.js';
import { AddPois1787000000000 } from '../../migrations-poi/1787000000000-AddPois.js';
import { AddPoiDecisionSupportFields1793000000000 } from '../../migrations-poi/1793000000000-AddPoiDecisionSupportFields.js';

const logger = new Logger('PoiDatabase');
const RETRY_MS = 10_000;

// Build + attempt to connect the POI DataSource WITHOUT ever throwing (ADR
// 0007). On failure the app still boots; the store services 503 until a
// background retry connects. `migrationsRun` in the options means a successful
// initialize() also applies the POI migrations.
export async function createPoiDataSource(
  options: DataSourceOptions,
): Promise<DataSource> {
  const ds = new DataSource(options);
  const connect = async (): Promise<void> => {
    try {
      await ds.initialize();
      logger.log('POI database connected');
    } catch (err) {
      logger.error(
        `POI database unavailable — POI store reads will 503 until it connects: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // Retry in the background so the app never blocks or fails boot on the
      // POI DB. `.unref()` keeps this timer from holding the process (or the
      // Jest worker in this module's spec) open — it must never be a reason
      // the process can't exit cleanly.
      const timer = setTimeout(() => void connect(), RETRY_MS);
      timer.unref();
    }
  };
  await connect();
  return ds;
}

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      name: 'poi',
      imports: [ConfigModule.forFeature(poiDatabaseConfig)],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
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
          migrationsRun: true,
          synchronize: false,
          // We own retries in createPoiDataSource; don't let TypeORM's own
          // retry loop throw at boot.
          retryAttempts: 0,
        };
      },
      dataSourceFactory: (options) => createPoiDataSource(options!),
    }),
  ],
})
export class PoiDatabaseModule {}
