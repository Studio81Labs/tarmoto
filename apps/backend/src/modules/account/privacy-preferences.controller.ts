import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard.js';
import {
  PrivacyPreferencesResponseDto,
  UpdatePrivacyPreferencesDto,
} from './dto/privacy-preferences.dto.js';
import { PrivacyPreferencesService } from './privacy-preferences.service.js';

@ApiTags('account')
@Controller('account/privacy')
export class PrivacyPreferencesController {
  constructor(private readonly prefs: PrivacyPreferencesService) {}

  @Get()
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Load the authenticated user's privacy preferences",
  })
  @ApiResponse({ status: 200, type: PrivacyPreferencesResponseDto })
  async get(@Req() req: Request): Promise<PrivacyPreferencesResponseDto> {
    return this.prefs.get(req.user!.userId);
  }

  @Put()
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Update privacy preferences (partial — supplied fields only)',
  })
  @ApiBody({ type: UpdatePrivacyPreferencesDto })
  @ApiResponse({ status: 200, type: PrivacyPreferencesResponseDto })
  async update(
    @Req() req: Request,
    @Body() dto: UpdatePrivacyPreferencesDto,
  ): Promise<PrivacyPreferencesResponseDto> {
    return this.prefs.update(req.user!.userId, dto);
  }
}
