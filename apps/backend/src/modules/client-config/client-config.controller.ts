import { Controller, Get, Header } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  GLOBAL_FEATURE_STATES,
  type GlobalFeatureStates,
} from '@tarmoto/shared';
import { ClientConfigService } from './client-config.service.js';

@ApiTags('config')
@Controller('config')
export class ClientConfigController {
  constructor(private readonly service: ClientConfigService) {}

  @Get('flags')
  @Header('Cache-Control', 'public, max-age=60')
  @ApiOperation({
    summary: 'Global feature-override map (feature → force_off | force_on)',
    description:
      'Only operator overrides appear here; a missing key means the ' +
      'feature resolves normally (registry default + tier + per-user ' +
      'override, served on /users/me). Clients apply force_off as an ' +
      'immediate kill switch but must not apply force_on from this map.',
  })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      additionalProperties: {
        type: 'string',
        enum: [...GLOBAL_FEATURE_STATES],
      },
    },
  })
  flags(): Promise<GlobalFeatureStates> {
    return this.service.featureStates();
  }
}
