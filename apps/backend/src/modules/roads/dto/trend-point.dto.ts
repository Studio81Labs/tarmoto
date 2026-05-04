import { ApiProperty } from '@nestjs/swagger';

export class TrendPointDto {
  @ApiProperty({ example: '2026-01' })
  month!: string;

  @ApiProperty({ example: 3.2 })
  score!: number;
}
