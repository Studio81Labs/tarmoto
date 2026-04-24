import { IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class VoteSuggestionDto {
  @ApiProperty({ enum: ['up', 'down'] })
  @IsIn(['up', 'down'])
  vote!: 'up' | 'down';
}
