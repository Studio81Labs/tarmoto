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
import { TripSharesService } from './trip-shares.service.js';
import {
  CreateTripShareDto,
  TripShareListResponseDto,
  TripSharePublicDto,
  TripShareResponseDto,
} from './dto/trip-share.dto.js';

@ApiTags('trip-shares')
@Controller('trip-shares')
export class TripSharesController {
  constructor(private readonly tripSharesService: TripSharesService) {}

  @Post()
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Create a shareable invite link for a trip snapshot (US-35)',
  })
  @ApiResponse({ status: 201, type: TripShareResponseDto })
  async create(
    @Req() req: express.Request,
    @Body() dto: CreateTripShareDto,
  ): Promise<TripShareResponseDto> {
    return this.tripSharesService.create(req.user!.userId, dto);
  }

  @Get('mine')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "List the caller's own trip shares" })
  @ApiResponse({ status: 200, type: TripShareListResponseDto })
  async listMine(
    @Req() req: express.Request,
  ): Promise<TripShareListResponseDto> {
    return this.tripSharesService.listMine(req.user!.userId);
  }

  @Get(':token')
  @ApiOperation({
    summary: 'View a shared trip by token (no auth required, read-only)',
  })
  @ApiResponse({ status: 200, type: TripSharePublicDto })
  @ApiResponse({ status: 404, description: 'Trip share not found' })
  async getByToken(@Param('token') token: string): Promise<TripSharePublicDto> {
    return this.tripSharesService.getByToken(token);
  }

  @Delete(':id')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke a trip share (owner only)' })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 403, description: 'Not the owner' })
  @ApiResponse({ status: 404, description: 'Trip share not found' })
  async revoke(
    @Req() req: express.Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.tripSharesService.revoke(req.user!.userId, id);
  }
}
