import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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
import { MapSharesService } from './map-shares.service.js';
import {
  CreateMapShareDto,
  MapShareListResponseDto,
  MapSharePublicDto,
  MapShareResponseDto,
} from './dto/map-share.dto.js';

@ApiTags('map-shares')
@Controller('map-shares')
export class MapSharesController {
  constructor(private readonly mapSharesService: MapSharesService) {}

  @Post()
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Create a shareable read-only link for a personal road-map snapshot (US-50)',
  })
  @ApiResponse({ status: 201, type: MapShareResponseDto })
  async create(
    @Req() req: express.Request,
    @Body() dto: CreateMapShareDto,
  ): Promise<MapShareResponseDto> {
    return this.mapSharesService.create(req.user!.userId, dto);
  }

  @Get('mine')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "List the caller's own road-map shares" })
  @ApiResponse({ status: 200, type: MapShareListResponseDto })
  async listMine(
    @Req() req: express.Request,
  ): Promise<MapShareListResponseDto> {
    return this.mapSharesService.listMine(req.user!.userId);
  }

  @Get(':token')
  @ApiOperation({
    summary:
      'View a shared road-map snapshot by token (no auth required, read-only)',
  })
  @ApiResponse({ status: 200, type: MapSharePublicDto })
  @ApiResponse({ status: 404, description: 'Map share not found' })
  async getByToken(@Param('token') token: string): Promise<MapSharePublicDto> {
    return this.mapSharesService.getByToken(token);
  }

  @Delete(':id')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke a map share (owner only)' })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 403, description: 'Not the owner' })
  @ApiResponse({ status: 404, description: 'Map share not found' })
  async revoke(
    @Req() req: express.Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.mapSharesService.revoke(req.user!.userId, id);
  }
}
