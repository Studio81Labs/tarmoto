/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { authGuardTestProviders } from '../auth/auth-test-providers.js';
import { SensorController } from './sensor.controller.js';
import { SensorService } from './sensor.service.js';

describe('SensorController', () => {
  let controller: SensorController;
  let service: jest.Mocked<SensorService>;

  beforeEach(async () => {
    const mockService = {
      processUpload: jest
        .fn()
        .mockResolvedValue({ accepted: 100, segments_updated: 3 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SensorController],
      providers: [
        { provide: SensorService, useValue: mockService },
        ...authGuardTestProviders,
      ],
    }).compile();

    controller = module.get<SensorController>(SensorController);
    service = module.get(SensorService);
  });

  describe('POST /sensor/upload', () => {
    it('should pass userId and dto to service', async () => {
      const req = { user: { userId: 'user-1' } } as never;
      const dto = {
        ride_id: 'ride-1',
        device_model: 'iPhone 15',
        readings: [{ t: 1000, ax: 0.1, ay: 0.2, az: 9.8 }],
      };

      const result = await controller.upload(req, dto);

      expect(service.processUpload).toHaveBeenCalledWith('user-1', dto);
      expect(result.accepted).toBe(100);
      expect(result.segments_updated).toBe(3);
    });
  });
});
