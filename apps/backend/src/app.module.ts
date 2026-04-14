import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { DatabaseModule } from './modules/database/database.module.js';
import { AuthModule } from './modules/auth/index.js';
import { HazardsModule } from './modules/hazards/index.js';
import { SensorModule } from './modules/sensor/index.js';
import { RoadsModule } from './modules/roads/index.js';
import { UsersModule } from './modules/users/index.js';
import { RidesModule } from './modules/rides/index.js';
import { EventsModule } from './modules/events/index.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 60 }],
    }),
    DatabaseModule,
    AuthModule,
    UsersModule,
    HazardsModule,
    SensorModule,
    RoadsModule,
    RidesModule,
    EventsModule,
  ],
  controllers: [AppController],
  providers: [AppService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
