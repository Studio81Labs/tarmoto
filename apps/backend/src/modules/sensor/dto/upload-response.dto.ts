import { ApiProperty } from '@nestjs/swagger';

export class UploadResponseDto {
  @ApiProperty({ description: 'Number of readings accepted' })
  accepted: number;

  @ApiProperty({ description: 'Road segments that got new quality data' })
  segments_updated: number;
}
