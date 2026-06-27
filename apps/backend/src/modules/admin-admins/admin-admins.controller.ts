import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AdminRoles } from '../admin-auth/admin-role.decorator.js';
import type { AdminRequest } from '../admin/internal.guard.js';
import {
  AdminAdminsService,
  type ActingAdmin,
} from './admin-admins.service.js';
import {
  AdminRowDto,
  CreateAdminDto,
  PatchAdminDto,
} from './dto/admin-admins.dto.js';

@ApiTags('admin')
@Controller('admin')
export class AdminAdminsController {
  constructor(private readonly service: AdminAdminsService) {}

  private actor(req: AdminRequest): ActingAdmin {
    if (!req.adminUser) throw new UnauthorizedException();
    return { id: req.adminUser.id, role: req.adminUser.role };
  }

  @Get('admins')
  @AdminRoles('admin')
  @ApiOperation({ summary: 'List admin (staff) accounts' })
  @ApiResponse({ status: 200, type: [AdminRowDto] })
  list(): Promise<AdminRowDto[]> {
    return this.service.list();
  }

  @Post('admins')
  @AdminRoles('admin')
  @ApiOperation({ summary: 'Create an admin account' })
  @ApiResponse({ status: 201, type: AdminRowDto })
  create(
    @Req() req: AdminRequest,
    @Body() dto: CreateAdminDto,
  ): Promise<AdminRowDto> {
    return this.service.create(this.actor(req), dto);
  }

  @Patch('admins/:id')
  @AdminRoles('admin')
  @ApiOperation({ summary: 'Change an admin role / enable-disable' })
  @ApiResponse({ status: 200, type: AdminRowDto })
  patch(
    @Req() req: AdminRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchAdminDto,
  ): Promise<AdminRowDto> {
    return this.service.patch(this.actor(req), id, dto);
  }
}
