import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AdminRoles } from '../admin-auth/admin-role.decorator.js';
import type { AdminRequest } from '../admin/internal.guard.js';
import { setAdminAuditTarget } from '../admin/admin-audit-context.js';
import { AdminFlagsService } from './admin-flags.service.js';
import {
  AdminFeatureFlagDto,
  AdminFeatureFlagUsersResponseDto,
  AdminFeatureFlagsResponseDto,
  AdminUserFeatureFlagsResponseDto,
  ListFeatureFlagUsersQueryDto,
  SetFeatureGlobalStateDto,
  SetFeatureOverrideDto,
} from './dto/admin-flags.dto.js';

/**
 * Operator surface for tier-aware feature entitlements. The flag set is
 * code-defined (`FEATURE_DEFINITIONS` in `@tarmoto/shared`) — there is no
 * create/delete; operators toggle global overrides (kill switch /
 * force-on) and per-user overrides. Reads are open to support; mutations
 * need the admin role. The free-form `reason` is stored on the
 * `feature_states` row and deliberately kept out of the audit payload.
 */
@ApiTags('admin')
@Controller('admin')
export class AdminFlagsController {
  constructor(private readonly service: AdminFlagsService) {}

  @Get('feature-flags')
  @AdminRoles('support')
  @ApiOperation({ summary: 'List the feature-flag registry with overrides' })
  @ApiResponse({ status: 200, type: AdminFeatureFlagsResponseDto })
  list(): Promise<AdminFeatureFlagsResponseDto> {
    return this.service.listFlags();
  }

  @Put('feature-flags/:feature/global')
  @AdminRoles('admin')
  @ApiOperation({
    summary: 'Set a global override (force_off kill switch / force_on)',
  })
  @ApiResponse({ status: 200, type: AdminFeatureFlagDto })
  setGlobal(
    @Req() req: AdminRequest,
    @Param('feature') feature: string,
    @Body() dto: SetFeatureGlobalStateDto,
  ): Promise<AdminFeatureFlagDto> {
    setAdminAuditTarget(req, {
      target_type: 'feature_flag',
      target_id: feature,
    });
    return this.service.setGlobalState(feature, dto, req.adminUser!.id);
  }

  @Delete('feature-flags/:feature/global')
  @AdminRoles('admin')
  @HttpCode(204)
  @ApiOperation({ summary: 'Clear a global override (back to normal)' })
  clearGlobal(
    @Req() req: AdminRequest,
    @Param('feature') feature: string,
  ): Promise<void> {
    setAdminAuditTarget(req, {
      target_type: 'feature_flag',
      target_id: feature,
    });
    return this.service.clearGlobalState(feature);
  }

  @Get('feature-flags/:feature/users')
  @AdminRoles('support')
  @ApiOperation({ summary: 'List users with a per-user override for a flag' })
  @ApiResponse({ status: 200, type: AdminFeatureFlagUsersResponseDto })
  listOverriddenUsers(
    @Param('feature') feature: string,
    @Query() query: ListFeatureFlagUsersQueryDto,
  ): Promise<AdminFeatureFlagUsersResponseDto> {
    return this.service.listOverriddenUsers(feature, query);
  }

  @Get('users/:userId/feature-flags')
  @AdminRoles('support')
  @ApiOperation({ summary: "A user's resolved flags + override states" })
  @ApiResponse({ status: 200, type: AdminUserFeatureFlagsResponseDto })
  getUserFlags(
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<AdminUserFeatureFlagsResponseDto> {
    return this.service.getUserFlags(userId);
  }

  @Put('users/:userId/feature-flags/:feature')
  @AdminRoles('admin')
  @ApiOperation({ summary: 'Set a per-user override (grant or revoke)' })
  @ApiResponse({ status: 200, type: AdminUserFeatureFlagsResponseDto })
  setOverride(
    @Req() req: AdminRequest,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('feature') feature: string,
    @Body() dto: SetFeatureOverrideDto,
  ): Promise<AdminUserFeatureFlagsResponseDto> {
    setAdminAuditTarget(req, { target_type: 'user', target_id: userId });
    return this.service.setOverride(userId, feature, dto);
  }

  @Delete('users/:userId/feature-flags/:feature')
  @AdminRoles('admin')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a per-user override' })
  removeOverride(
    @Req() req: AdminRequest,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('feature') feature: string,
  ): Promise<void> {
    setAdminAuditTarget(req, { target_type: 'user', target_id: userId });
    return this.service.removeOverride(userId, feature);
  }
}
