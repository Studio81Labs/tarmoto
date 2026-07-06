import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AdminRoles } from '../admin-auth/admin-role.decorator.js';
import type { AdminRequest } from '../admin/internal.guard.js';
import { setAdminAuditTarget } from '../admin/admin-audit-context.js';
import { AppSettingsService } from './app-settings.service.js';
import {
  LaunchTierResponseDto,
  SetLaunchTierDto,
} from './dto/launch-tier.dto.js';

/**
 * Operator surface for launch mode (sibling `launch_all_pro`, with a tier
 * picker): while a launch tier is set, new registrations are auto-granted
 * that tier with `plan_source = 'founder'`.
 */
@ApiTags('admin')
@Controller('admin/system-settings')
export class AdminAppSettingsController {
  constructor(private readonly service: AppSettingsService) {}

  @Get('launch-tier')
  @AdminRoles('support')
  @ApiOperation({ summary: 'Current launch-mode auto-grant tier' })
  @ApiResponse({ status: 200, type: LaunchTierResponseDto })
  getLaunchTier(): Promise<LaunchTierResponseDto> {
    return this.service.getLaunchTier();
  }

  @Put('launch-tier')
  @AdminRoles('admin')
  @ApiOperation({
    summary: 'Set the launch-mode auto-grant tier (null = off)',
  })
  @ApiResponse({ status: 200, type: LaunchTierResponseDto })
  setLaunchTier(
    @Req() req: AdminRequest,
    @Body() dto: SetLaunchTierDto,
  ): Promise<LaunchTierResponseDto> {
    setAdminAuditTarget(req, {
      target_type: 'app_setting',
      target_id: 'launch_tier',
    });
    return this.service.setLaunchTier(dto.tier, req.adminUser!.id);
  }
}
