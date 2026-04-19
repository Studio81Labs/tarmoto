import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class QueryFunZonesDto {
  @ApiProperty({
    description: 'Bounding box: west,south,east,north',
    example: '18.1,49.4,18.6,49.7',
  })
  @IsString()
  bbox!: string;
}
