import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AdminMetricsService } from './admin-metrics.service.js';
import { AdminMetricsDto } from './dto/admin-metrics.dto.js';

@ApiTags('admin')
@Controller('admin')
export class AdminMetricsController {
  constructor(private readonly service: AdminMetricsService) {}

  @Get('metrics')
  @ApiOperation({ summary: 'Admin overview metrics' })
  @ApiResponse({ status: 200, type: AdminMetricsDto })
  metrics(): Promise<AdminMetricsDto> {
    return this.service.snapshot();
  }
}
