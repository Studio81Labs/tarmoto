import { ApiProperty } from '@nestjs/swagger';

export class RoadTrendPointDto {
  @ApiProperty({ example: '2026-01' })
  month!: string;

  @ApiProperty({ example: 3.2 })
  avg_iri!: number;

  @ApiProperty({ example: 15 })
  reading_count!: number;
}

export class RoadTrendDto {
  @ApiProperty({ example: 'uuid' })
  segment_id!: string;

  @ApiProperty({ type: [RoadTrendPointDto] })
  points!: RoadTrendPointDto[];
}
