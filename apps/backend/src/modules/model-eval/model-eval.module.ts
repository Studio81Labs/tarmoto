import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ModelEvalSample } from '../../entities/model-eval-sample.entity.js';
import { SurfaceReading } from '../../entities/surface-reading.entity.js';
import { Ride } from '../../entities/ride.entity.js';
import { AuthModule } from '../auth/index.js';
import { ModelEvalController } from './model-eval.controller.js';
import {
  MODEL_EVAL_RANDOM_TOKEN,
  ModelEvalService,
} from './model-eval.service.js';

@Module({
  imports: [
    ConfigModule,
    AuthModule,
    TypeOrmModule.forFeature([ModelEvalSample, SurfaceReading, Ride]),
  ],
  controllers: [ModelEvalController],
  providers: [
    ModelEvalService,
    // Default random source — tests override via `MODEL_EVAL_RANDOM_TOKEN`.
    { provide: MODEL_EVAL_RANDOM_TOKEN, useValue: () => Math.random() },
  ],
  exports: [ModelEvalService],
})
export class ModelEvalModule {}
