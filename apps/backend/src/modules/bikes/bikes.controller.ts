import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  ParseUUIDPipe,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard.js';
import { BikesService } from './bikes.service.js';
import { CreateBikeDto, UpdateBikeDto, BikeDto } from './dto/bike.dto.js';
import type { Request } from 'express';

@ApiTags('account')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('account/bikes')
export class BikesController {
  constructor(private readonly bikesService: BikesService) {}

  @Get()
  @ApiOperation({ summary: 'List your bikes' })
  @ApiResponse({ status: 200, type: [BikeDto] })
  list(@Req() req: Request): Promise<BikeDto[]> {
    return this.bikesService.list(req.user!.userId);
  }

  @Post()
  @ApiOperation({ summary: 'Add a bike' })
  @ApiResponse({ status: 201, type: BikeDto })
  create(@Req() req: Request, @Body() dto: CreateBikeDto): Promise<BikeDto> {
    return this.bikesService.create(req.user!.userId, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a bike' })
  @ApiResponse({ status: 200, type: BikeDto })
  @ApiResponse({ status: 404 })
  update(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBikeDto,
  ): Promise<BikeDto> {
    return this.bikesService.update(req.user!.userId, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a bike' })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 404 })
  async delete(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.bikesService.delete(req.user!.userId, id);
  }
}
