import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AdminRoles } from '../admin-auth/admin-role.decorator.js';
import { AdminUsersService } from './admin-users.service.js';
import {
  AdminUserDetailDto,
  AdminUserListResponseDto,
  ListAdminUsersQueryDto,
} from './dto/admin-users.dto.js';

@ApiTags('admin')
@Controller('admin')
export class AdminUsersController {
  constructor(private readonly service: AdminUsersService) {}

  @Get('users')
  @AdminRoles('support')
  @ApiOperation({ summary: 'List app users (paginated, searchable)' })
  @ApiResponse({ status: 200, type: AdminUserListResponseDto })
  list(
    @Query() query: ListAdminUsersQueryDto,
  ): Promise<AdminUserListResponseDto> {
    return this.service.list(query);
  }

  @Get('users/:id')
  @AdminRoles('support')
  @ApiOperation({ summary: 'App user detail + activity counts' })
  @ApiResponse({ status: 200, type: AdminUserDetailDto })
  getById(@Param('id', ParseUUIDPipe) id: string): Promise<AdminUserDetailDto> {
    return this.service.getById(id);
  }

  @Delete('users/:id')
  @AdminRoles('support')
  @HttpCode(204)
  @ApiOperation({ summary: 'Soft-delete an app user' })
  softDelete(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.service.softDelete(id);
  }

  @Post('users/:id/restore')
  @AdminRoles('support')
  @HttpCode(204)
  @ApiOperation({ summary: 'Restore a soft-deleted app user' })
  restore(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.service.restore(id);
  }
}
