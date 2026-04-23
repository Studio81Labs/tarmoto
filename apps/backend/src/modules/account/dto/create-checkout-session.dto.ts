import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export class CreateCheckoutSessionDto {
  @ApiProperty({ enum: ['premium', 'pro'] })
  @IsIn(['premium', 'pro'])
  tier!: 'premium' | 'pro';
}
