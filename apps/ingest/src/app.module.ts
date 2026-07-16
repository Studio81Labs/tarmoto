import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
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
})
export class AppModule {}
