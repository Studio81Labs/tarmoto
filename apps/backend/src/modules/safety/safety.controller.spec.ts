/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { SafetyController } from './safety.controller.js';
import { SafetyService } from './safety.service.js';

describe('SafetyController', () => {
  let controller: SafetyController;
  let service: jest.Mocked<SafetyService>;

  const mockReq = { user: { userId: 'user-1' } } as never;

  beforeEach(async () => {
    const mockService = {
      sendCrashAlert: jest.fn().mockResolvedValue({
        contacts_notified: 2,
        alert_id: 'alert-123',
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SafetyController],
      providers: [
        { provide: SafetyService, useValue: mockService },
        { provide: JwtService, useValue: { verifyAsync: jest.fn() } },
      ],
    }).compile();

    controller = module.get<SafetyController>(SafetyController);
    service = module.get(SafetyService);
  });

  describe('POST /safety/crash-alert', () => {
    it('should send crash alert and return response', async () => {
      const dto = { lat: 49.1, lng: 16.75, speed_at_impact: 72 };
      const result = await controller.sendCrashAlert(mockReq, dto);

      expect(service.sendCrashAlert).toHaveBeenCalledWith('user-1', dto);
      expect(result.contacts_notified).toBe(2);
      expect(result.alert_id).toBe('alert-123');
    });
  });
});
