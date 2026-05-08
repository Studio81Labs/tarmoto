import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import * as express from 'express';
import { AuthGuard } from '../auth/auth.guard.js';
import { TripFoldersService } from './trip-folders.service.js';
import {
  CreateTripFolderDto,
  TripFolderListResponseDto,
  TripFolderResponseDto,
  UpdateTripFolderDto,
} from './dto/trip-folder.dto.js';

@ApiTags('trip-folders')
@Controller('trip-folders')
@UseGuards(AuthGuard)
@ApiBearerAuth()
export class TripFoldersController {
  constructor(private readonly tripFoldersService: TripFoldersService) {}

  @Get()
  @ApiOperation({
    summary: "List the caller's trip folders ordered by manual position.",
  })
  @ApiResponse({ status: 200, type: TripFolderListResponseDto })
  async list(@Req() req: express.Request): Promise<TripFolderListResponseDto> {
    return this.tripFoldersService.list(req.user!.userId);
  }

  @Post()
  @ApiOperation({
    summary:
      'Create a new trip folder. The folder is appended to the end of the caller’s list.',
  })
  @ApiResponse({ status: 201, type: TripFolderResponseDto })
  async create(
    @Req() req: express.Request,
    @Body() dto: CreateTripFolderDto,
  ): Promise<TripFolderResponseDto> {
    return this.tripFoldersService.create(req.user!.userId, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      'Rename, recolour, or reorder a folder. Cross-user updates 404 (not 403).',
  })
  @ApiResponse({ status: 200, type: TripFolderResponseDto })
  @ApiResponse({ status: 404, description: 'Folder not found or not owned' })
  async update(
    @Req() req: express.Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTripFolderDto,
  ): Promise<TripFolderResponseDto> {
    return this.tripFoldersService.update(req.user!.userId, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Delete a folder. Trips inside become unfiled (`folder_id` is set to NULL via the FK).',
  })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 404, description: 'Folder not found or not owned' })
  async remove(
    @Req() req: express.Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.tripFoldersService.remove(req.user!.userId, id);
  }
}
