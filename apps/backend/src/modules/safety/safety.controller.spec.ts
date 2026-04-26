/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { SafetyController } from './safety.controller.js';
import { SafetyService } from './safety.service.js';
import { UserScopedThrottlerGuard } from './user-scoped-throttler.guard.js';

describe('SafetyController', () => {
  let controller: SafetyController;
  let service: jest.Mocked<SafetyService>;

  const mockReq = { user: { userId: 'user-1' } } as never;

  beforeEach(async () => {
    const mockService = {
      sendCrashAlert: jest.fn().mockResolvedValue({
        contacts_notified: 2,
        alert_id: 'alert-123',
        contacts: [
          {
            contact_id: 'c-1',
            name: 'Jane',
            channel: 'sms',
            status: 'sent',
            provider_message_id: 'SM-1',
            error: null,
          },
        ],
        idempotent_replay: false,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      // ThrottlerModule populates the providers UserScopedThrottlerGuard
      // depends on (THROTTLER:MODULE_OPTIONS, ThrottlerStorage). The
      // values are arbitrary here — the guard is constructed via the
      // controller's @UseGuards but this test only exercises the
      // controller method.
      imports: [
        ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 5 }] }),
      ],
      controllers: [SafetyController],
      providers: [
        { provide: SafetyService, useValue: mockService },
        { provide: JwtService, useValue: { verifyAsync: jest.fn() } },
        UserScopedThrottlerGuard,
      ],
    }).compile();

    controller = module.get<SafetyController>(SafetyController);
    service = module.get(SafetyService);
  });

  describe('POST /safety/crash-alert', () => {
    it('sends crash alert and returns the per-contact response', async () => {
      const dto = {
        lat: 49.1,
        lng: 16.75,
        speed_at_impact: 72,
        severity: 'high' as const,
      };
      const result = await controller.sendCrashAlert(mockReq, dto);

      expect(service.sendCrashAlert).toHaveBeenCalledWith('user-1', dto);
      expect(result.contacts_notified).toBe(2);
      expect(result.alert_id).toBe('alert-123');
      expect(result.contacts[0].channel).toBe('sms');
      expect(result.idempotent_replay).toBe(false);
    });
  });
});
