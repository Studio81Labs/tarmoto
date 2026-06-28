import { Controller, Get, Header } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FeatureFlagMap } from '@tarmoto/shared';
import { ClientConfigService } from './client-config.service.js';

@ApiTags('config')
@Controller('config')
export class ClientConfigController {
  constructor(private readonly service: ClientConfigService) {}

  @Get('flags')
  @Header('Cache-Control', 'public, max-age=60')
  @ApiOperation({ summary: 'Public feature-flag map (key → enabled)' })
  @ApiResponse({
    status: 200,
    schema: { type: 'object', additionalProperties: { type: 'boolean' } },
  })
  flags(): Promise<FeatureFlagMap> {
    return this.service.flags();
  }
}
