import { ApiProperty } from '@nestjs/swagger';

/** Response body for `GET /poi/health` (ADR 0007). */
export class PoiHealthDto {
  @ApiProperty({
    enum: ['up', 'down'],
    example: 'up',
    description: 'Whether the separate POI database is currently reachable.',
  })
  poiDb!: 'up' | 'down';
}
