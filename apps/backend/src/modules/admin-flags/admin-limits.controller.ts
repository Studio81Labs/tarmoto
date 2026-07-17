import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Put,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AdminRoles } from '../admin-auth/admin-role.decorator.js';
import type { AdminRequest } from '../admin/internal.guard.js';
import { setAdminAuditTarget } from '../admin/admin-audit-context.js';
import { AdminLimitsService } from './admin-limits.service.js';
import {
  AdminFeatureLimitDto,
  AdminFeatureLimitsResponseDto,
  AdminUserFeatureLimitsResponseDto,
  SetLimitGlobalValueDto,
  SetUserLimitOverrideDto,
} from './dto/admin-limits.dto.js';

/**
 * Operator surface for numeric limit entitlements — the numeric twin of
 * `AdminFlagsController`. The limit set is code-defined
 * (`FEATURE_DEFINITIONS` in `@tarmoto/shared`) — there is no
 * create/delete; operators manage global overrides (launch mode / promo
 * raise / restrict) and per-user overrides. Reads are open to support;
 * mutations need the admin role. Unlike the toggle twin, `reason` is
 * always required on a global mutation (any global limit change is
 * user-visible). It is stored on the `limit_states` row and deliberately
 * kept out of the audit payload. No limit gates a socket, so there is no
 * eviction side effect to trigger here.
 */
@ApiTags('admin')
@Controller('admin')
export class AdminLimitsController {
  constructor(private readonly service: AdminLimitsService) {}

  @Get('feature-limits')
  @AdminRoles('support')
  @ApiOperation({ summary: 'List the limit registry with overrides' })
  @ApiResponse({ status: 200, type: AdminFeatureLimitsResponseDto })
  list(): Promise<AdminFeatureLimitsResponseDto> {
    return this.service.listLimits();
  }

  @Put('feature-limits/:feature/global')
  @AdminRoles('admin')
  @ApiOperation({
    summary: 'Set a global limit override (launch mode / promo raise)',
  })
  @ApiResponse({ status: 200, type: AdminFeatureLimitDto })
  setGlobal(
    @Req() req: AdminRequest,
    @Param('feature') feature: string,
    @Body() dto: SetLimitGlobalValueDto,
  ): Promise<AdminFeatureLimitDto> {
    setAdminAuditTarget(req, {
      target_type: 'feature_limit',
      target_id: feature,
    });
    return this.service.setGlobalValue(feature, dto, req.adminUser!.id);
  }

  @Delete('feature-limits/:feature/global')
  @AdminRoles('admin')
  @HttpCode(204)
  @ApiOperation({ summary: 'Clear a global limit override (back to normal)' })
  clearGlobal(
    @Req() req: AdminRequest,
    @Param('feature') feature: string,
  ): Promise<void> {
    setAdminAuditTarget(req, {
      target_type: 'feature_limit',
      target_id: feature,
    });
    return this.service.clearGlobalValue(feature);
  }

  @Get('users/:userId/feature-limits')
  @AdminRoles('support')
  @ApiOperation({ summary: "A user's resolved limits + override states" })
  @ApiResponse({ status: 200, type: AdminUserFeatureLimitsResponseDto })
  getUserLimits(
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<AdminUserFeatureLimitsResponseDto> {
    return this.service.getUserLimits(userId);
  }

  @Put('users/:userId/feature-limits/:feature')
  @AdminRoles('admin')
  @ApiOperation({
    summary: 'Set a per-user limit override (raise or restrict)',
  })
  @ApiResponse({ status: 200, type: AdminUserFeatureLimitsResponseDto })
  setOverride(
    @Req() req: AdminRequest,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('feature') feature: string,
    @Body() dto: SetUserLimitOverrideDto,
  ): Promise<AdminUserFeatureLimitsResponseDto> {
    setAdminAuditTarget(req, { target_type: 'user', target_id: userId });
    return this.service.setOverride(userId, feature, dto);
  }

  @Delete('users/:userId/feature-limits/:feature')
  @AdminRoles('admin')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a per-user limit override' })
  removeOverride(
    @Req() req: AdminRequest,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('feature') feature: string,
  ): Promise<void> {
    setAdminAuditTarget(req, { target_type: 'user', target_id: userId });
    return this.service.removeOverride(userId, feature);
  }
}
