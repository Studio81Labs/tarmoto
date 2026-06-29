import { ApiProperty } from '@nestjs/swagger';

export class AdminMetricsDto {
  @ApiProperty() users!: number;
  @ApiProperty() activeRides!: number;
  @ApiProperty() featureFlags!: number;
  @ApiProperty() closures!: number;
  @ApiProperty() hiddenContent!: number;
}
