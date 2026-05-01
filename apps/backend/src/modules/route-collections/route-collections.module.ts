import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RouteCollection } from '../../entities/route-collection.entity.js';
import { RouteCollectionItem } from '../../entities/route-collection-item.entity.js';
import { RouteCollectionsController } from './route-collections.controller.js';
import { RouteCollectionsService } from './route-collections.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([RouteCollection, RouteCollectionItem])],
  controllers: [RouteCollectionsController],
  providers: [RouteCollectionsService],
  exports: [RouteCollectionsService],
})
export class RouteCollectionsModule {}
