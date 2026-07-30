/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import {
  ForbiddenException,
  NotFoundException,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { authGuardTestProviders } from '../auth/auth-test-providers.js';
import { featureGuardTestProviders } from '../features/feature-test-providers.js';
import { FeatureGuard } from '../features/feature.guard.js';
import { RidesController } from './rides.controller.js';
import { RidesService } from './rides.service.js';
import { GpxService } from './gpx.service.js';

describe('RidesController', () => {
  let controller: RidesController;
  let service: jest.Mocked<RidesService>;

  const mockReq = { user: { userId: 'user-1' } } as never;

  const mockRide = {
    id: 'ride-1',
    status: 'active',
    ride_type: 'free',
    started_at: '2026-04-14T10:00:00.000Z',
    ended_at: null,
    distance_km: null,
    avg_speed: null,
    avg_road_quality: null,
  };

  beforeEach(async () => {
    const mockService = {
      start: jest.fn().mockResolvedValue(mockRide),
      stop: jest.fn().mockResolvedValue({ ...mockRide, status: 'completed' }),
      list: jest.fn().mockResolvedValue({ rides: [mockRide], total: 1 }),
      getDetail: jest.fn().mockResolvedValue(mockRide),
      rename: jest.fn(),
      exportGpx: jest.fn().mockResolvedValue('<gpx></gpx>'),
      exportRideCsv: jest.fn().mockResolvedValue('header\r\ndata\r\n'),
      exportAllCsv: jest.fn().mockResolvedValue('header\r\nd1\r\nd2\r\n'),
      exportAllGpx: jest.fn().mockResolvedValue('<gpx></gpx>'),
      getTracks: jest.fn().mockResolvedValue({ tracks: [], truncated: false }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [RidesController],
      providers: [
        { provide: RidesService, useValue: mockService },
        { provide: GpxService, useValue: { importGpx: jest.fn() } },
        ...authGuardTestProviders,
        ...featureGuardTestProviders,
      ],
    }).compile();

    controller = module.get<RidesController>(RidesController);
    service = module.get(RidesService);
  });

  describe('POST /rides/start', () => {
    it('should start a ride', async () => {
      const result = await controller.start(mockReq, {});

      expect(service.start).toHaveBeenCalledWith('user-1', {});
      expect(result.status).toBe('active');
    });
  });

  describe('POST /rides/:rideId/stop', () => {
    it('should stop a ride', async () => {
      const result = await controller.stop(mockReq, 'ride-1');

      expect(service.stop).toHaveBeenCalledWith('user-1', 'ride-1');
      expect(result.status).toBe('completed');
    });
  });

  describe('GET /rides', () => {
    it('should return ride list', async () => {
      const result = await controller.list(mockReq, {});

      expect(service.list).toHaveBeenCalledWith('user-1', {});
      expect(result.total).toBe(1);
    });
  });

  describe('GET /rides/:rideId', () => {
    it('should return ride detail', async () => {
      await controller.getDetail(mockReq, 'ride-1');

      expect(service.getDetail).toHaveBeenCalledWith('user-1', 'ride-1');
    });

    it('should propagate NotFoundException', async () => {
      service.getDetail.mockRejectedValueOnce(new NotFoundException());

      await expect(controller.getDetail(mockReq, 'missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('PATCH /rides/:rideId', () => {
    it('calls service.rename with the user and new name', async () => {
      service.rename.mockResolvedValue({
        ...mockRide,
        name: 'Renamed',
      } as never);
      const result = await controller.rename(mockReq, 'ride-1', {
        name: 'Renamed',
      });
      expect(service.rename).toHaveBeenCalledWith(
        'user-1',
        'ride-1',
        'Renamed',
      );
      expect(result.name).toBe('Renamed');
    });
  });

  describe('GET /rides/:rideId/csv', () => {
    it('writes CSV with correct headers and filename', async () => {
      const res = mockResponse();

      await controller.exportRideCsv(mockReq, res.response, 'ride-1');

      expect(service.exportRideCsv).toHaveBeenCalledWith('user-1', 'ride-1');
      expect(res.setMock).toHaveBeenCalledWith(
        'Content-Type',
        'text/csv; charset=utf-8',
      );
      expect(res.setMock).toHaveBeenCalledWith(
        'Content-Disposition',
        'attachment; filename="tarmoto-ride-ride-1.csv"',
      );
      expect(res.sendMock).toHaveBeenCalledWith('header\r\ndata\r\n');
    });
  });

  describe('GET /rides/export.csv', () => {
    it('writes CSV with a date-stamped filename', async () => {
      const res = mockResponse();

      await controller.exportAllCsv(mockReq, res.response);

      expect(service.exportAllCsv).toHaveBeenCalledWith('user-1');
      expect(res.setMock).toHaveBeenCalledWith(
        'Content-Type',
        'text/csv; charset=utf-8',
      );
      expect(res.dispositionHeader()).toMatch(
        /^attachment; filename="tarmoto-rides-\d{4}-\d{2}-\d{2}\.csv"$/,
      );
      expect(res.sendMock).toHaveBeenCalledWith('header\r\nd1\r\nd2\r\n');
    });
  });

  describe('GET /rides/tracks', () => {
    it('forwards the user and filters to the service', async () => {
      const result = await controller.tracks(mockReq, {
        type: 'trip',
      });
      expect(service.getTracks).toHaveBeenCalledWith('user-1', {
        type: 'trip',
      });
      expect(result.truncated).toBe(false);
    });
  });

  describe('GET /rides/export.gpx', () => {
    it('writes GPX with a date-stamped filename', async () => {
      const res = mockResponse();

      await controller.exportAllGpx(mockReq, res.response);

      expect(service.exportAllGpx).toHaveBeenCalledWith('user-1');
      expect(res.setMock).toHaveBeenCalledWith(
        'Content-Type',
        'application/gpx+xml',
      );
      expect(res.dispositionHeader()).toMatch(
        /^attachment; filename="tarmoto-rides-\d{4}-\d{2}-\d{2}\.gpx"$/,
      );
    });
  });
});

function mockResponse() {
  const setMock = jest.fn<void, [string, string]>();
  const sendMock = jest.fn<void, [unknown]>();
  const response = {
    set: setMock,
    send: sendMock,
  } as unknown as import('express').Response;
  return {
    response,
    setMock,
    sendMock,
    dispositionHeader(): string | undefined {
      const call = setMock.mock.calls.find(
        ([name]) => name === 'Content-Disposition',
      );
      return call?.[1];
    },
  };
}

describe('RidesController gpx_import feature guard', () => {
  const importHandler = RidesController.prototype.importGpx;

  function guardContext(
    handler: object,
    user?: { userId: string },
  ): ExecutionContext {
    return {
      getHandler: () => handler,
      getClass: () => RidesController,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as unknown as ExecutionContext;
  }

  it('blocks POST /rides/import with a 403 when gpx_import is force_off', async () => {
    const guard = new FeatureGuard(new Reflector(), {
      resolveForUser: jest.fn().mockResolvedValue({ gpx_import: false }),
      getGlobalStates: jest.fn().mockResolvedValue({}),
    } as never);

    await expect(
      guard.canActivate(guardContext(importHandler, { userId: 'user-1' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows POST /rides/import through when gpx_import is on', async () => {
    const guard = new FeatureGuard(new Reflector(), {
      resolveForUser: jest.fn().mockResolvedValue({ gpx_import: true }),
      getGlobalStates: jest.fn().mockResolvedValue({}),
    } as never);

    await expect(
      guard.canActivate(guardContext(importHandler, { userId: 'user-1' })),
    ).resolves.toBe(true);
  });
});
