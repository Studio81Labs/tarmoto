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
  Query,
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
import { ClosuresService } from './closures.service.js';
import {
  CreateClosureDto,
  ListClosuresQueryDto,
  RoadClosureDto,
  UpdateClosureDto,
} from './dto/closures.dto.js';

@ApiTags('closures')
@Controller('closures')
export class ClosuresController {
  constructor(private readonly closures: ClosuresService) {}

  @Get()
  @ApiOperation({
    summary: 'List road closures',
    description:
      'Returns closures currently in effect. Use `active_on` to preview ' +
      'a future instant, `include_past=true` for the full history, and ' +
      '`bbox` / `severity` / `reason` to narrow the set.',
  })
  @ApiResponse({ status: 200, type: [RoadClosureDto] })
  async list(@Query() query: ListClosuresQueryDto): Promise<RoadClosureDto[]> {
    return this.closures.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single road closure by id' })
  @ApiResponse({ status: 200, type: RoadClosureDto })
  @ApiResponse({ status: 404, description: 'Closure not found' })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<RoadClosureDto> {
    return this.closures.getById(id);
  }

  @Post()
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a road closure' })
  @ApiResponse({ status: 201, type: RoadClosureDto })
  async create(
    @Req() req: express.Request,
    @Body() dto: CreateClosureDto,
  ): Promise<RoadClosureDto> {
    return this.closures.create(req.user!.userId, dto);
  }

  @Patch(':id')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Update a road closure',
    description: 'Only the creator may update their own closures.',
  })
  @ApiResponse({ status: 200, type: RoadClosureDto })
  @ApiResponse({ status: 403, description: 'Not the creator' })
  @ApiResponse({ status: 404, description: 'Closure not found' })
  async update(
    @Req() req: express.Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateClosureDto,
  ): Promise<RoadClosureDto> {
    return this.closures.update(id, req.user!.userId, dto);
  }

  @Delete(':id')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a road closure',
    description: 'Only the creator may delete their own closures.',
  })
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiResponse({ status: 403, description: 'Not the creator' })
  @ApiResponse({ status: 404, description: 'Closure not found' })
  async remove(
    @Req() req: express.Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.closures.remove(id, req.user!.userId);
  }
}
