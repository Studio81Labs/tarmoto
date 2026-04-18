import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MountainPass } from '../../entities/mountain-pass.entity.js';
import { PassesController } from './passes.controller.js';
import { PassesService } from './passes.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([MountainPass])],
  controllers: [PassesController],
  providers: [PassesService],
  exports: [PassesService],
})
export class PassesModule {}
