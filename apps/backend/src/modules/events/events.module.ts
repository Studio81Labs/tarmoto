import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { redisConfig } from '../../config/redis.config.js';
import { EventsGateway } from './events.gateway.js';

@Module({
  imports: [ConfigModule.forFeature(redisConfig)],
  providers: [EventsGateway],
  exports: [EventsGateway],
})
export class EventsModule {}
