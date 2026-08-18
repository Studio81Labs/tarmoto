import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Delete,
  Body,
  HttpCode,
  HttpStatus,
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
  ApiExtraModels,
  getSchemaPath,
} from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard.js';
import { BikesService } from './bikes.service.js';
import { CreateBikeDto, UpdateBikeDto, BikeDto } from './dto/bike.dto.js';
import type { Request } from 'express';

@ApiTags('account')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@ApiExtraModels(BikeDto)
@Controller('account/bikes')
export class BikesController {
  constructor(private readonly bikesService: BikesService) {}

  @Get()
  @ApiOperation({ summary: 'List your bikes' })
  @ApiResponse({ status: 200, type: [BikeDto] })
  list(@Req() req: Request): Promise<BikeDto[]> {
    return this.bikesService.list(req.user!.userId);
  }

  // Dedicated lookup the mobile HUD calls on every `RideActiveScreen`
  // mount. Returning just the active bike skips the per-bike stats
  // aggregation that `list` runs (`COUNT(*) + SUM(distance_km)` over
  // the rides table grouped by bike), which is wasteful when all the
  // chip needs is `make` / `model`. Returns 200 with `null` when the
  // rider has no garage yet so the mobile branch logic stays simple.
  @Get('active')
  @ApiOperation({ summary: 'Get your active bike (or null)' })
  @ApiResponse({
    status: 200,
    description: 'Active bike, or `null` when the rider has no garage yet.',
    schema: {
      // The spec is OpenAPI 3.0, where `{ type: 'null' }` is a 3.1-ism the
      // validator rejects — 3.0 spells a nullable ref as nullable + allOf.
      // openapi-typescript emits `BikeDto | null` for both shapes, so the
      // generated client type is unchanged.
      nullable: true,
      allOf: [{ $ref: getSchemaPath(BikeDto) }],
    },
  })
  active(@Req() req: Request): Promise<BikeDto | null> {
    return this.bikesService.getActive(req.user!.userId);
  }

  @Post()
  @ApiOperation({ summary: 'Add a bike' })
  @ApiResponse({ status: 201, type: BikeDto })
  create(@Req() req: Request, @Body() dto: CreateBikeDto): Promise<BikeDto> {
    return this.bikesService.create(req.user!.userId, dto);
  }

  // The contract calls for PUT semantics (full upsert from the rider's
  // perspective — every field in the form gets written), but we accept
  // PATCH at the same path so the in-flight companion build that ships
  // partial bodies isn't broken during the rollout. Both verbs route to
  // the same partial-update service call.
  @Put(':id')
  @ApiOperation({ summary: 'Update a bike' })
  @ApiResponse({ status: 200, type: BikeDto })
  @ApiResponse({ status: 404 })
  put(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBikeDto,
  ): Promise<BikeDto> {
    return this.bikesService.update(req.user!.userId, id, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a bike (partial)' })
  @ApiResponse({ status: 200, type: BikeDto })
  @ApiResponse({ status: 404 })
  patch(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBikeDto,
  ): Promise<BikeDto> {
    return this.bikesService.update(req.user!.userId, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
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
