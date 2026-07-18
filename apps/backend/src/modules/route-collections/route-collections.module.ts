import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RouteCollection } from '../../entities/route-collection.entity.js';
import { RouteCollectionItem } from '../../entities/route-collection-item.entity.js';
import { RouteCollectionFollow } from '../../entities/route-collection-follow.entity.js';
import { AccountModule } from '../account/account.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { FeaturesModule } from '../features/features.module.js';
import { RouteCollectionsController } from './route-collections.controller.js';
import { RouteCollectionsService } from './route-collections.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      RouteCollection,
      RouteCollectionItem,
      RouteCollectionFollow,
    ]),
    AccountModule,
    AuthModule,
    FeaturesModule,
  ],
  controllers: [RouteCollectionsController],
  providers: [RouteCollectionsService],
  exports: [RouteCollectionsService],
})
export class RouteCollectionsModule {}
