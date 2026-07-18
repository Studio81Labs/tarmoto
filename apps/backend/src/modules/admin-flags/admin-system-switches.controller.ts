import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Put,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AdminRoles } from '../admin-auth/admin-role.decorator.js';
import type { AdminRequest } from '../admin/internal.guard.js';
import { setAdminAuditTarget } from '../admin/admin-audit-context.js';
import { AdminSystemSwitchesService } from './admin-system-switches.service.js';
import {
  AdminSystemSwitchDto,
  AdminSystemSwitchesResponseDto,
  SetSystemSwitchDisabledDto,
} from './dto/admin-system-switches.dto.js';

/**
 * Operator surface for system switches (kill toggles, default ON). The
 * switch set is code-defined — no create/delete; operators disable / enable
 * only. Reads open to support; mutations need the admin role.
 */
@ApiTags('admin')
@Controller('admin')
export class AdminSystemSwitchesController {
  constructor(private readonly service: AdminSystemSwitchesService) {}

  @Get('system-switches')
  @AdminRoles('support')
  @ApiOperation({ summary: 'List the system switches with resolved state' })
  @ApiResponse({ status: 200, type: AdminSystemSwitchesResponseDto })
  list(): Promise<AdminSystemSwitchesResponseDto> {
    return this.service.listSwitches();
  }

  @Put('system-switches/:key/disable')
  @AdminRoles('admin')
  @ApiOperation({ summary: 'Disable a subsystem (operator kill switch)' })
  @ApiResponse({ status: 200, type: AdminSystemSwitchDto })
  disable(
    @Req() req: AdminRequest,
    @Param('key') key: string,
    @Body() dto: SetSystemSwitchDisabledDto,
  ): Promise<AdminSystemSwitchDto> {
    setAdminAuditTarget(req, { target_type: 'system_switch', target_id: key });
    return this.service.disableSwitch(key, dto, req.adminUser!.id);
  }

  @Delete('system-switches/:key/disable')
  @AdminRoles('admin')
  @HttpCode(204)
  @ApiOperation({ summary: 'Re-enable a subsystem (clear the kill switch)' })
  enable(@Req() req: AdminRequest, @Param('key') key: string): Promise<void> {
    setAdminAuditTarget(req, { target_type: 'system_switch', target_id: key });
    return this.service.enableSwitch(key);
  }
}
