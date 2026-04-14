import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiProduces,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import * as express from 'express';
import { AuthGuard } from '../auth/auth.guard.js';
import { RidesService } from './rides.service.js';
import { GpxService } from './gpx.service.js';
import { StartRideDto } from './dto/start-ride.dto.js';
import { ListRidesDto } from './dto/list-rides.dto.js';
import {
  RideResponseDto,
  RideSummaryDto,
  RideDetailDto,
  RideListResponseDto,
} from './dto/ride-response.dto.js';

@ApiTags('rides')
@Controller('rides')
@UseGuards(AuthGuard)
@ApiBearerAuth()
export class RidesController {
  constructor(
    private readonly ridesService: RidesService,
    private readonly gpxService: GpxService,
  ) {}

  @Get()
  @ApiOperation({ summary: "List user's rides" })
  @ApiResponse({ status: 200, type: RideListResponseDto })
  async list(
    @Req() req: express.Request,
    @Query() query: ListRidesDto,
  ): Promise<RideListResponseDto> {
    return this.ridesService.list(req.user!.userId, query);
  }

  @Post('start')
  @ApiOperation({ summary: 'Start a new ride' })
  @ApiResponse({ status: 201, type: RideResponseDto })
  @ApiResponse({ status: 400, description: 'Already have an active ride' })
  async start(
    @Req() req: express.Request,
    @Body() dto: StartRideDto,
  ): Promise<RideResponseDto> {
    return this.ridesService.start(req.user!.userId, dto);
  }

  @Post(':rideId/stop')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Stop an active ride' })
  @ApiResponse({ status: 200, type: RideResponseDto })
  @ApiResponse({ status: 404, description: 'Ride not found' })
  async stop(
    @Req() req: express.Request,
    @Param('rideId', ParseUUIDPipe) rideId: string,
  ): Promise<RideResponseDto> {
    return this.ridesService.stop(req.user!.userId, rideId);
  }

  @Get(':rideId')
  @ApiOperation({ summary: 'Get ride details with stats' })
  @ApiResponse({ status: 200, type: RideDetailDto })
  @ApiResponse({ status: 404, description: 'Ride not found' })
  async getDetail(
    @Req() req: express.Request,
    @Param('rideId', ParseUUIDPipe) rideId: string,
  ): Promise<RideDetailDto> {
    return this.ridesService.getDetail(req.user!.userId, rideId);
  }

  @Post('import')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }), // 10 MB max
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Import a GPX file as a route' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiResponse({ status: 201, type: RideSummaryDto })
  async importGpx(
    @Req() req: express.Request,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<RideSummaryDto> {
    if (!file) {
      throw new BadRequestException('GPX file is required');
    }
    const ride = await this.gpxService.importGpx(req.user!.userId, file.buffer);
    return this.ridesService.toSummary(ride);
  }

  @Get(':rideId/gpx')
  @ApiOperation({ summary: 'Export ride as GPX' })
  @ApiProduces('application/gpx+xml')
  @ApiResponse({ status: 200, description: 'GPX file' })
  @ApiResponse({ status: 404, description: 'Ride not found' })
  async exportGpx(
    @Req() req: express.Request,
    @Res() res: express.Response,
    @Param('rideId', ParseUUIDPipe) rideId: string,
  ): Promise<void> {
    const gpx = await this.ridesService.exportGpx(req.user!.userId, rideId);
    res.set('Content-Type', 'application/gpx+xml');
    res.set(
      'Content-Disposition',
      `attachment; filename="tarmoto-ride-${rideId}.gpx"`,
    );
    res.send(gpx);
  }
}
