import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_FILTER } from "@nestjs/core";
import { SentryGlobalFilter } from "@sentry/nestjs/setup";
import { ScheduleModule } from "@nestjs/schedule";
import { HealthController } from "./health.controller.js";
import { PoiModule } from "./poi/poi.module.js";
import { PoiJobsModule } from "./poi/jobs.module.js";
import { PoiInternalModule } from "./internal/poi-internal.module.js";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PoiModule,
    PoiJobsModule,
    PoiInternalModule,
  ],
  controllers: [HealthController],
  providers: [
    // Captures unhandled exceptions to Sentry. Harmless when Sentry is not
    // configured (no DSN → Sentry.init never ran → nothing is sent).
    { provide: APP_FILTER, useClass: SentryGlobalFilter },
  ],
})
export class AppModule {}
