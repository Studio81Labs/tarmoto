import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TripFolder } from '../../entities/trip-folder.entity.js';
import { AuthModule } from '../auth/auth.module.js';
import { TripFoldersController } from './trip-folders.controller.js';
import { TripFoldersService } from './trip-folders.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([TripFolder]), AuthModule],
  controllers: [TripFoldersController],
  providers: [TripFoldersService],
  exports: [TripFoldersService],
})
export class TripFoldersModule {}
