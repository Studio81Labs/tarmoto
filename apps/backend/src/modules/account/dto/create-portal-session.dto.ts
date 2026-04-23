import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

export class CreatePortalSessionDto {
  @ApiPropertyOptional({
    enum: [
      'manage',
      'payment_method_update',
      'subscription_cancel',
      'subscription_update',
    ],
    default: 'manage',
  })
  @IsOptional()
  @IsIn([
    'manage',
    'payment_method_update',
    'subscription_cancel',
    'subscription_update',
  ])
  flow?:
    | 'manage'
    | 'payment_method_update'
    | 'subscription_cancel'
    | 'subscription_update';
}
