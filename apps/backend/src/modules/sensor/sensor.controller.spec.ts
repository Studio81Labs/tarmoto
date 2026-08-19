import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { authGuardTestProviders } from '../auth/auth-test-providers.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { SystemSwitchGuard } from '../features/system-switch.guard.js';
import { REQUIRED_SYSTEM_SWITCH_KEY } from '../features/require-system-switch.decorator.js';
import { FeatureResolver } from '../features/feature-resolver.service.js';
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
        {
          provide: FeatureResolver,
          useValue: {
            isSystemSwitchEnabled: jest.fn().mockResolvedValue(true),
          },
        },
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

    it('POST /sensor/upload authenticates before the system-switch lookup', () => {
      const guards = Reflect.getMetadata(
        '__guards__',
        SensorController.prototype.upload,
      ) as unknown[];
      expect(guards).toBeDefined();
      // AuthGuard first: an anonymous request is 401'd without the switch
      // guard's feature_states read / state leak. SystemSwitchGuard still
      // runs in the guard phase (before validation) for authenticated uploads.
      expect(guards[0]).toBe(AuthGuard);
      expect(guards).toContain(SystemSwitchGuard);
    });

    it('POST /sensor/upload declares the sys_surface_upload switch', () => {
      const key = Reflect.getMetadata(
        REQUIRED_SYSTEM_SWITCH_KEY,
        SensorController.prototype.upload,
      ) as string | undefined;
      expect(key).toBe('sys_surface_upload');
    });
  });
});
