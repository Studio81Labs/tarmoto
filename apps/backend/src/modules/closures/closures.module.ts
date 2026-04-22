import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RoadClosure } from '../../entities/road-closure.entity.js';
import { ClosuresController } from './closures.controller.js';
import { ClosuresService } from './closures.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([RoadClosure])],
  controllers: [ClosuresController],
  providers: [ClosuresService],
  exports: [ClosuresService],
})
export class ClosuresModule {}
